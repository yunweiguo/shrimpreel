// KIE 官方 Market API：多张人物参考图 + 一个动作参考视频。创建接口未声明幂等键，
// 所以发送前先在 D1 写入不可重放的占位 ID；响应不确定时等待管理员核对或超时退款，不自动再扣供应商费用。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import { VideoProviderError, type VideoProvider, type VideoSubmitInput, type VideoStatus } from './types'

const API = 'https://api.kie.ai/api/v1/jobs'
const UNCERTAIN = 'kie-unconfirmed:'
export const KIE_MODEL = 'bytedance/seedance-2-fast'

export function kieInput(input: VideoSubmitInput) {
  const images = [input.imageUrl, ...(input.secondaryImageUrl ? [input.secondaryImageUrl] : [])]
  for (const value of [...images, input.sourceVideoUrl]) {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password)
      throw new VideoProviderError('kie_invalid_input', 'KIE reference URLs must use HTTPS', false)
  }
  const roles = input.secondaryImageUrl
    ? 'Image 1 is person A; image 2 is person B. Preserve their distinct identities, faces, hair and outfits in both shots.'
    : 'Image 1 supplies the identity for both person A and person B: two separate twins of the same person. Preserve this face, hair and outfit in both shots.'
  return {
    model: KIE_MODEL,
    ...(input.webhookUrl.startsWith('https://') ? { callBackUrl: input.webhookUrl } : {}),
    input: {
      prompt: `${roles} ${input.style.prompt ?? site.video.kie.prompt}`,
      reference_image_urls: images,
      reference_video_urls: [input.sourceVideoUrl],
      duration: input.durationSeconds,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
      web_search: false,
      nsfw_checker: true,
    },
  }
}

export function createKieProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.KIE_API_KEY)
  return {
    id: 'kie',
    async submit(input) {
      if (!key) throw new VideoProviderError('provider_not_configured', 'KIE_API_KEY missing', false)
      const body = kieInput(input)
      const marker = `${UNCERTAIN}${input.generationId}`
      const claimed = await env.DB.prepare(
        "UPDATE generations SET provider_request_id = ? WHERE id = ? AND status = 'processing' AND provider_request_id IS NULL",
      )
        .bind(marker, input.generationId)
        .run()
      if (!claimed.meta.changes) {
        const row = await env.DB.prepare('SELECT provider_request_id FROM generations WHERE id = ?')
          .bind(input.generationId)
          .first<{ provider_request_id: string | null }>()
        if (!row?.provider_request_id) throw new VideoProviderError('kie_task_missing', 'Generation no longer exists', false)
        return { requestId: row.provider_request_id, meta: input.meta }
      }
      let response: Response
      try {
        response = await fetch(`${API}/createTask`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(25000),
        })
      } catch {
        return { requestId: marker, meta: { ...input.meta, submissionUnconfirmed: true } }
      }
      const data = (await response.json().catch(() => null)) as { code?: number; data?: { taskId?: string } } | null
      if (response.ok && data?.code === 200 && typeof data.data?.taskId === 'string' && data.data.taskId.length > 0)
        return { requestId: data.data.taskId, meta: input.meta }
      // 明确拒绝可退款；5xx/未知响应可能已受理，保留占位 ID，绝不自动重投。
      const code = data?.code ?? response.status
      if ([400, 401, 402, 403, 404, 422, 429].includes(code))
        throw new VideoProviderError(`kie_submit_${code}`, `KIE rejected submission (${code})`, false)
      return { requestId: marker, meta: { ...input.meta, submissionUnconfirmed: true } }
    },
    async status(requestId): Promise<VideoStatus> {
      if (requestId.startsWith(UNCERTAIN)) return { state: 'pending' }
      if (!key) throw new VideoProviderError('provider_not_configured', 'KIE_API_KEY missing', false)
      let response: Response
      try {
        response = await fetch(`${API}/recordInfo?taskId=${encodeURIComponent(requestId)}`, {
          headers: { Authorization: `Bearer ${key}` },
          redirect: 'error',
          signal: AbortSignal.timeout(25000),
        })
      } catch {
        throw new VideoProviderError('kie_status_network', 'KIE status unavailable', true)
      }
      const body = (await response.json().catch(() => null)) as {
        code?: number
        data?: { taskId?: string; state?: string; resultJson?: string; model?: string }
      } | null
      if (!response.ok || body?.code !== 200 || body.data?.taskId !== requestId)
        throw new VideoProviderError('kie_status_unavailable', 'KIE status could not be verified', true)
      const data = body.data
      if (data.model && data.model !== KIE_MODEL)
        throw new VideoProviderError('kie_model_mismatch', 'KIE returned an unexpected model', false)
      if (data.state === 'fail') return { state: 'failed', code: 'kie_generation_failed', message: 'KIE could not generate this video' }
      if (data.state !== 'success') return { state: 'pending' }
      let url: unknown
      try {
        url = JSON.parse(data.resultJson ?? '{}').resultUrls?.[0]
      } catch {
        /* 缺失结果不交付 */
      }
      if (typeof url !== 'string') return { state: 'failed', code: 'kie_missing_video', message: 'KIE completed without a video' }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new VideoProviderError('kie_untrusted_output', 'KIE returned an invalid output URL', false)
      }
      if (
        parsed.protocol !== 'https:' ||
        parsed.hostname !== 'tempfile.aiquickdraw.com' ||
        parsed.port ||
        parsed.username ||
        parsed.password
      )
        throw new VideoProviderError('kie_untrusted_output', 'KIE returned an unrecognized output host', false)
      return { state: 'completed', output: { url } }
    },
    // 参考片 + 输出片均计费，价格是站点配置的估算值；上线前必须按供应商账单校准。
    costCents(seconds) {
      return site.video.kie.costCentsPerSecond > 0 ? Math.round(seconds * 2 * site.video.kie.costCentsPerSecond) : null
    },
  }
}
