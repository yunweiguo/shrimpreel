import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultStyle } from '#/config/site'
import { createKieProvider, kieInput, KIE_MODEL } from '#/server/video/kie'
import { d1Shim, migrate } from './d1-sqlite'

const input = {
  generationId: 'gen_kie',
  style: defaultStyle,
  durationSeconds: 8,
  imageUrl: 'https://hop.example.com/media/uploads/a?sig=a',
  secondaryImageUrl: 'https://hop.example.com/media/uploads/b?sig=b',
  sourceVideoUrl: 'https://hop.example.com/media/templates/hop.mp4',
  sourceVideoKey: 'templates/hop.mp4',
  webhookUrl: 'https://hop.example.com/api/webhooks/kie?gen=gen_kie&token=token',
  meta: {},
}
let sqlite: DatabaseSync
let env: Env
const ok = (data: unknown) => Response.json({ code: 200, data })
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  migrate(sqlite)
  const now = new Date().toISOString()
  sqlite.prepare('INSERT INTO users (id,email,credits,created_at) VALUES (?,?,0,?)').run('usr', 'u@example.com', now)
  sqlite
    .prepare(
      "INSERT INTO generations (id,user_id,template_id,duration_id,duration_seconds,credits_cost,upload_id,status,provider,created_at,updated_at) VALUES ('gen_kie','usr','t','full',8,8,'upl','processing','kie',?,?)",
    )
    .run(now, now)
  env = { DB: d1Shim(sqlite), KIE_API_KEY: 'test-key' } as unknown as Env
})
afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('KIE 多图动作参考', () => {
  it('双人和双胞胎分别传两张与一张参考图，不混入首尾帧，固定关闭生成音频', () => {
    const duo = kieInput(input)
    expect(duo).toMatchObject({
      model: KIE_MODEL,
      input: {
        reference_image_urls: [input.imageUrl, input.secondaryImageUrl],
        reference_video_urls: [input.sourceVideoUrl],
        duration: 8,
        generate_audio: false,
        nsfw_checker: true,
      },
    })
    expect(duo.input).not.toHaveProperty('first_frame_url')
    const twin = kieInput({ ...input, secondaryImageUrl: undefined })
    expect(twin.input.reference_image_urls).toEqual([input.imageUrl])
    expect(twin.input.prompt).toContain('both person A and person B')
  })
  it('拒绝非 HTTPS 素材，未配置密钥时不发请求', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(() => kieInput({ ...input, imageUrl: 'http://localhost/a' })).toThrow('HTTPS')
    await expect(createKieProvider({ ...env, KIE_API_KEY: '' }).submit(input)).rejects.toMatchObject({ code: 'provider_not_configured' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('提交前先持久化占位，网络响应丢失后重试不重复扣费', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('response lost'))
    vi.stubGlobal('fetch', fetch)
    const provider = createKieProvider(env)
    const first = await provider.submit(input)
    expect(first.requestId).toBe('kie-unconfirmed:gen_kie')
    expect(await provider.submit(input)).toMatchObject({ requestId: first.requestId })
    expect(await provider.status(first.requestId, {})).toEqual({ state: 'pending' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('Worker 保存最终任务 ID 前崩溃也不会重新向供应商提交', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ taskId: 'remote-123' }))
    vi.stubGlobal('fetch', fetch)
    const provider = createKieProvider(env)
    expect(await provider.submit(input)).toMatchObject({ requestId: 'remote-123' })
    expect(await provider.submit(input)).toMatchObject({ requestId: 'kie-unconfirmed:gen_kie' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('明确拒绝不可重试；供应商 5xx 保留待确认任务', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 402 }, { status: 200 })))
    await expect(createKieProvider(env).submit(input)).rejects.toMatchObject({ code: 'kie_submit_402', retryable: false })
    sqlite.prepare('UPDATE generations SET provider_request_id=NULL').run()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })))
    expect(await createKieProvider(env).submit(input)).toMatchObject({ requestId: 'kie-unconfirmed:gen_kie' })
  })
  it('只交付匹配任务和已知 HTTPS 媒体域名的结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ok({
            taskId: 'remote',
            model: KIE_MODEL,
            state: 'success',
            resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/result.mp4'] }),
          }),
        ),
    )
    expect(await createKieProvider(env).status('remote', {})).toMatchObject({
      state: 'completed',
      output: { url: 'https://tempfile.aiquickdraw.com/result.mp4' },
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ok({ taskId: 'remote', state: 'success', resultJson: JSON.stringify({ resultUrls: ['http://127.0.0.1/admin'] }) }),
        ),
    )
    await expect(createKieProvider(env).status('remote', {})).rejects.toMatchObject({ code: 'kie_untrusted_output' })
  })
  it('查询任务不匹配时不给出成片；未知成本不记成零', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ taskId: 'other', state: 'success' })))
    await expect(createKieProvider(env).status('remote', {})).rejects.toMatchObject({ code: 'kie_status_unavailable' })
    expect(createKieProvider(env).costCents(8, defaultStyle.id)).toBeNull()
  })
})
