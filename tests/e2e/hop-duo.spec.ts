import { expect, test } from '@playwright/test'
import { site } from '../../src/config/site'
import { ORIGIN, PHOTO, buyPackage, credits, devLogin, durationCredits, json, post, uniqueEmail, uploadPhoto } from './helpers'

test('Hop 双人：两张照片后才能提交，模式切换保留第一张照片，生成成功只扣一次积分', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('hop-ui'))
  await buyPackage(page.request, 'starter')
  const before = await credits(page.request)
  await page.goto('/')
  await expect(page.getByTestId('generate')).toBeVisible()
  await page.getByTestId('photo-input').setInputFiles(PHOTO)
  await page.getByTestId('consent').check()
  await expect(page.getByTestId('generate')).toBeDisabled()
  await page.getByTestId('mode-twins').click()
  await page.getByTestId('consent').check()
  await expect(page.getByTestId('generate')).toBeEnabled()
  await page.getByTestId('mode-duo').click()
  await page.getByTestId('photo-input-second').setInputFiles(PHOTO)
  await page.getByTestId('consent').check()
  await expect(page.getByTestId('generate')).toBeEnabled()
  await page.getByTestId('generate').click()
  await expect(page.getByTestId('generation-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 60000 })
  expect(await credits(page.request)).toBe(before - durationCredits(site.durations.at(-1)!.id))
  const exported = await json<{ generations: Array<{ secondaryUploadId: string | null }> }>(page.request.get('/api/account/export'))
  expect(exported.generations[0]?.secondaryUploadId).toBeTruthy()
})

test('Hop 双人：缺少第二张、越权或重复上传 ID 均不扣积分', async ({ request, playwright }) => {
  await devLogin(request, uniqueEmail('hop-owner'))
  await buyPackage(request, 'starter')
  const before = await credits(request)
  const { upload: a } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const other = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(other, uniqueEmail('hop-other'))
    const { upload: b } = await json<{ upload: { id: string } }>(uploadPhoto(other), 201)
    const base = { uploadId: a.id, mode: 'duo', durationId: 'full' }
    await json(post(request, '/api/generations', base), 400)
    await json(post(request, '/api/generations', { ...base, secondaryUploadId: b.id }), 400)
    await json(post(request, '/api/generations', { ...base, secondaryUploadId: a.id }), 400)
    expect(await credits(request)).toBe(before)
  } finally {
    await other.dispose()
  }
})

test('Hop 双人：处理中保留两张原图，失败退款后两张都能过期清理', async ({ request }) => {
  await devLogin(request, uniqueEmail('hop-retention'))
  await buyPackage(request, 'starter')
  const before = await credits(request)
  const { upload: a } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const { upload: b } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const { generation } = await json<{ generation: { id: string } }>(
    post(request, '/api/generations', { uploadId: a.id, secondaryUploadId: b.id, mode: 'duo', durationId: 'full', mockOutcome: 'fail' }),
    201,
  )
  expect(await json(post(request, '/api/dev/sweep', { days: 8 }))).toEqual({ uploads: 0, outputs: 0 })
  await expect
    .poll(
      async () => (await json<{ generation: { status: string } }>(request.get(`/api/generations/${generation.id}`))).generation.status,
      { timeout: 60000 },
    )
    .toBe('failed')
  expect(await credits(request)).toBe(before)
  expect(await json(post(request, '/api/dev/sweep', { days: 8 }))).toEqual({ uploads: 2, outputs: 0 })
  await json(post(request, '/api/generations', { uploadId: a.id, secondaryUploadId: b.id, mode: 'duo', durationId: 'full' }), 400)
})
