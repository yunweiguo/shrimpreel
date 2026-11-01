import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { removeReportedContent } from '#/server/takedown'
import type { GenerationRow } from '#/server/types'
import { d1Shim, migrate } from './d1-sqlite'

vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: async () => {} }))

describe('双人照片生命周期', () => {
  it('第二角色的照片出现在其它任务时也关联下架，不删除无关成片', async () => {
    const sql = new DatabaseSync(':memory:')
    migrate(sql)
    const stamp = new Date().toISOString()
    sql.prepare('INSERT INTO users (id,email,credits,created_at) VALUES (?,?,0,?)').run('usr', 'u@example.com', stamp)
    for (const id of ['a', 'b', 'c'])
      sql
        .prepare("INSERT INTO uploads(id,user_id,r2_key,content_type,size_bytes,sha256,created_at) VALUES (?,?,?,'image/jpeg',1,?,?)")
        .run(id, 'usr', `uploads/${id}`, `hash-${id}`, stamp)
    for (const [id, first, second] of [
      ['reported', 'a', 'b'],
      ['also-b', 'c', 'b'],
      ['unrelated', 'c', null],
    ]) {
      sql
        .prepare(
          "INSERT INTO generations(id,user_id,template_id,duration_id,duration_seconds,credits_cost,upload_id,secondary_upload_id,status,provider,output_r2_key,created_at,updated_at) VALUES (?,'usr','t','full',8,8,?,?,'succeeded','mock',?,?,?)",
        )
        .run(id, first, second, `outputs/${id}`, stamp, stamp)
    }
    const deleted: string[] = []
    const env = {
      DB: d1Shim(sql),
      MEDIA: { delete: async (keys: string | string[]) => deleted.push(...(Array.isArray(keys) ? keys : [keys])) },
    } as unknown as Env
    const row = sql.prepare("SELECT * FROM generations WHERE id='reported'").get() as unknown as GenerationRow
    const result = await removeReportedContent(env, row, 'report_1')
    expect(result.generations).toBe(2)
    expect(deleted).toEqual(expect.arrayContaining(['uploads/a', 'uploads/b', 'outputs/reported', 'outputs/also-b']))
    expect(deleted).not.toContain('uploads/c')
    expect(deleted).not.toContain('outputs/unrelated')
    expect(sql.prepare("SELECT removed_at FROM generations WHERE id='also-b'").get()?.removed_at).toBeTruthy()
    expect(sql.prepare("SELECT removed_at FROM generations WHERE id='unrelated'").get()?.removed_at).toBeNull()
    expect(sql.prepare('SELECT sha256 FROM blocked_media ORDER BY sha256').all()).toEqual([{ sha256: 'hash-a' }, { sha256: 'hash-b' }])
    sql.close()
  })
})
