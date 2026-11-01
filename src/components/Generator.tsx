import { useRouterState } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, Download, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { STYLES, cheapestPackageCovering, defaultStyle, formatPrice, site } from '#/config/site'
import { api, errorCode, isActiveGeneration, type Generation } from '#/lib/api'
import { track } from '#/lib/attribution'
import { useCheckout } from '#/lib/checkout'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'
import { AiBadge, ErrorText, GoogleIcon, LocalLink, Spinner, formatDate } from './ui'

type Photo = { file: File; previewUrl: string; uploadId: string | null }

const POLL_MS = 3000

// styleId / onStyleChange：首页把风格状态提到外面，让 hero 标签和生成器同步；不传时生成器自己管
export function Generator({ styleId: controlledStyleId, onStyleChange }: { styleId?: string; onStyleChange?: (id: string) => void } = {}) {
  const c = useContent()
  const g = c.generator
  const lp = useLocalePath()
  const locale = useLocale()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading, refresh } = useSession()
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [secondPhoto, setSecondPhoto] = useState<Photo | null>(null)
  const [mode, setMode] = useState<'duo' | 'twins'>(site.duoEnabled ? 'duo' : 'twins')
  const [uploading, setUploading] = useState(false)
  const [ownStyleId, setOwnStyleId] = useState<string>(defaultStyle.id)
  const styleId = controlledStyleId ?? ownStyleId
  const selectStyle = onStyleChange ?? setOwnStyleId
  const [durationId, setDurationId] = useState<string>(site.durations[site.durations.length - 1]!.id)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState<Generation | null>(null)

  const checkout = useCheckout()
  const duration = site.durations.find((d) => d.id === durationId) ?? site.durations[0]!
  const shortfall = user ? Math.max(0, duration.credits - user.credits) : 0
  // 余额不足时直接在这里下单够用的最便宜积分包；没有够用的包就退回去价格页
  const coverPack = shortfall > 0 ? cheapestPackageCovering(shortfall) : undefined

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.previewUrl)
  }, [photo?.previewUrl])
  useEffect(() => () => {
    if (secondPhoto) URL.revokeObjectURL(secondPhoto.previewUrl)
  }, [secondPhoto?.previewUrl])

  // 轮询当前任务直到结束；结束后刷新余额（失败时积分已退回）
  useEffect(() => {
    if (!generation || !isActiveGeneration(generation)) return
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ generation: Generation }>(`/api/generations/${generation.id}`)
        setGeneration(data.generation)
        if (!isActiveGeneration(data.generation)) await refresh()
      } catch (err) {
        setError(errorCode(err))
        setGeneration({ ...generation })
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [generation, refresh])

  async function upload(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const data = await api<{ upload: { id: string } }>('/api/uploads', { form })
      return data.upload.id
    } finally {
      setUploading(false)
    }
  }

  async function selectFile(file: File | undefined, slot = 0) {
    if (!file || busy) return
    const setSelected = slot === 0 ? setPhoto : setSecondPhoto
    setError(null)
    if (!(site.upload.contentTypes as readonly string[]).includes(file.type)) return setError('unsupported_file_type')
    if (file.size > site.upload.maxBytes) return setError('file_too_large')
    setConsent(false)
    const next: Photo = { file, previewUrl: URL.createObjectURL(file), uploadId: null }
    setSelected(next)
    setGeneration(null)
    if (!user) return
    try {
      const uploadId = await upload(file)
      setSelected((current) => (current?.file === file ? { ...current, uploadId } : current))
    } catch (err) {
      setError(errorCode(err))
    }
  }

  async function generate() {
    if (busy || !consent) return
    if (!photo) return setError('invalid_upload')
    if (mode === 'duo' && !secondPhoto) return setError('second_photo_required')
    setError(null)
    setSubmitting(true)
    try {
      const uploadId = photo.uploadId ?? (await upload(photo.file))
      if (!photo.uploadId) setPhoto({ ...photo, uploadId })
      const secondaryUploadId = mode === 'duo' && secondPhoto ? secondPhoto.uploadId ?? (await upload(secondPhoto.file)) : undefined
      if (secondaryUploadId && secondPhoto && !secondPhoto.uploadId) setSecondPhoto({ ...secondPhoto, uploadId: secondaryUploadId })
      const data = await api<{ generation: Generation }>('/api/generations', { json: { uploadId, secondaryUploadId, mode, durationId, styleId, locale } })
      track('generate_video', { style_id: styleId, duration_id: durationId, credits: data.generation.creditsCost })
      setGeneration(data.generation)
      await refresh()
    } catch (err) {
      setError(errorCode(err))
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setGeneration(null)
    setError(null)
  }

  const busy = uploading || submitting || (generation !== null && isActiveGeneration(generation))

  return (
    <section
      className="card space-y-5 p-5 shadow-[0_1px_0_var(--line),0_20px_40px_-24px_rgba(0,0,0,0.25)] sm:p-6"
      aria-labelledby="generator-title"
      data-testid="generator"
    >
      {/* 标题只给读屏和大纲用：页面 H1 之后接 H2，步骤标题是 H3 */}
      <h2 id="generator-title" className="sr-only">
        {g.title}
      </h2>
      {/* 1. 照片 */}
      <section className="space-y-3">
        <StepTitle n={1}>{g.stepPhoto}</StepTitle>
        {site.duoEnabled ? (
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={g.modeLabel}>
            {(['duo', 'twins'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={busy}
                data-testid={`mode-${value}`} onClick={() => {setMode(value); setConsent(false); setError(null)}}
                className={`rounded-xl border px-3 py-3 text-left text-sm ${mode === value ? 'border-ink bg-ink text-ink-fg' : 'border-line'}`}>
                <span className="block font-semibold">{g.modes[value]}</span>
                <span className="mt-1 block text-xs opacity-75">{g.modeHints[value]}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className={mode === 'duo' ? 'grid gap-3 sm:grid-cols-2' : ''}>
          <PhotoSlot photo={photo} label={mode === 'duo' ? g.personA : g.stepPhoto} testId="photo-input"
            busy={busy} uploading={uploading} onSelect={(file) => void selectFile(file)} />
          {mode === 'duo' ? <PhotoSlot photo={secondPhoto} label={g.personB} testId="photo-input-second"
            busy={busy} uploading={uploading} onSelect={(file) => void selectFile(file, 1)} /> : null}
        </div>
        <p className="text-xs leading-5 text-muted">{g.guidance}</p>
      </section>

      {/* 2. 风格：只有一种风格时不显示 */}
      {STYLES.length > 1 ? (
        <section className="space-y-3">
          <StepTitle n={2}>{g.stepStyle}</StepTitle>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={g.stepStyle}>
            {STYLES.map((style) => {
              const active = style.id === styleId
              const copy = c.styles[style.id as keyof typeof c.styles]
              const thumb = style.examples.aiVersions[0]
              return (
                <button
                  key={style.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy}
                  data-testid={`style-${style.id}`}
                  onClick={() => selectStyle(style.id)}
                  className={`flex items-center gap-3 rounded-xl p-2 text-left transition ${active ? 'bg-card shadow-sm ring-2 ring-ink' : 'bg-bg-soft text-muted ring-1 ring-line hover:text-fg'}`}
                >
                  {thumb ? <img src={thumb.poster} alt="" loading="lazy" className="aspect-[3/4] w-10 shrink-0 rounded-md object-cover" /> : null}
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-fg">{copy.name}</span>
                    <span className="block text-xs text-muted">{copy.tagline}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* 时长 */}
      <section className="space-y-3">
        <StepTitle n={STYLES.length > 1 ? 3 : 2}>{g.stepLength}</StepTitle>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-bg-soft p-1" role="radiogroup" aria-label={g.stepLength}>
          {site.durations.map((d) => {
            const active = d.id === durationId
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                data-testid={`duration-${d.id}`}
                onClick={() => setDurationId(d.id)}
                className={`rounded-lg px-2 py-2 text-center transition ${active ? 'bg-card shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg'}`}
              >
                <span className="block text-sm font-semibold">
                  {g.seconds(d.seconds)}
                  {'isFull' in d && d.isFull ? ` · ${g.full}` : ''}
                </span>
                <span className="block text-xs text-muted">{g.creditsLabel(d.credits)}</span>
              </button>
            )
          })}
        </div>
      </section>

      <label className="flex items-start gap-3 text-xs leading-5 text-muted">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
          data-testid="consent"
        />
        <span>{g.consent}</span>
      </label>

      {/* CTA */}
      <div className="space-y-2">
        {loading ? (
          <div className="btn-primary w-full py-3.5 opacity-60">
            <Spinner />
          </div>
        ) : !user ? (
          <a href={signInHref(config, pathname, lp('/sign-in'))} className="btn-primary w-full py-3.5" data-testid="generator-sign-up">
            <GoogleIcon /> {g.ctaSignUp}
          </a>
        ) : shortfall > 0 && coverPack ? (
          <>
            <button
              type="button"
              className="btn-primary w-full py-3.5"
              disabled={checkout.pending !== null || checkout.paused}
              onClick={() => checkout.buy(coverPack.id)}
              data-testid="generator-buy"
            >
              {checkout.paused ? (
                c.pricing.paused
              ) : checkout.pending === coverPack.id ? (
                <>
                  <Spinner /> {c.pricing.buying}
                </>
              ) : (
                g.ctaBuyPack(coverPack.credits, formatPrice(coverPack.priceCents, coverPack.currency))
              )}
            </button>
            <p className="text-center text-xs">
              <LocalLink to="/pricing" className="text-muted underline" data-testid="generator-see-packs">
                {g.seePacks}
              </LocalLink>
            </p>
            <ErrorText code={checkout.error} />
          </>
        ) : shortfall > 0 ? (
          <LocalLink to="/pricing" className="btn-primary w-full py-3.5" data-testid="generator-buy">
            {g.ctaBuy}
          </LocalLink>
        ) : (
          <button
            type="button"
            className="btn-primary w-full py-3.5"
            disabled={busy || !photo || (mode === 'duo' && !secondPhoto) || !consent}
            onClick={generate}
            data-testid="generate"
          >
            {submitting ? <Spinner /> : null}
            {g.ctaGenerate(duration.credits)}
          </button>
        )}
        {user ? (
          <p className="text-center text-xs text-muted" data-testid="generator-balance">
            {g.balance(user.credits)}
            {shortfall > 0 ? ` · ${g.needMore(shortfall)}` : ''}
          </p>
        ) : null}
        {user && photo && !consent && !generation ? <p className="text-center text-xs text-muted">{g.needConsent}</p> : null}
        <ErrorText code={error} />
      </div>

      {generation ? <GenerationResult generation={generation} onReset={reset} /> : null}
    </section>
  )
}

// 两个角色复用同一个上传控件，格式、忙碌状态和无障碍标签保持一致。
function PhotoSlot({photo,label,testId,busy,uploading,onSelect}:{photo:Photo|null;label:string;testId:string;busy:boolean;uploading:boolean;onSelect:(file:File|undefined)=>void}) {
  const g=useContent().generator
  const inputRef=useRef<HTMLInputElement>(null)
  const [dragging,setDragging]=useState(false)
  return <div className="space-y-2">
    <p className="text-xs font-semibold">{label}</p>
    <input ref={inputRef} type="file" accept={site.upload.contentTypes.join(',')} className="sr-only" tabIndex={-1}
      aria-label={label} data-testid={testId} disabled={busy}
      onChange={(event)=>{onSelect(event.target.files?.[0]);event.target.value=''}} />
    <button type="button" disabled={busy} aria-label={`${label}: ${photo ? g.change : g.dropTitle}`}
      onClick={()=>inputRef.current?.click()}
      onDragOver={(e)=>{e.preventDefault();if(!busy)setDragging(true)}} onDragLeave={()=>setDragging(false)}
      onDrop={(e)=>{e.preventDefault();setDragging(false);if(!busy)onSelect(e.dataTransfer.files?.[0])}}
      className={`flex min-h-40 w-full items-center justify-center rounded-xl border-2 border-dashed p-4 text-center transition ${dragging?'border-accent bg-accent/5':'border-line hover:border-fg/40'}`}>
      {photo ? <span className="flex flex-col items-center gap-2">
        <img src={photo.previewUrl} alt="" className="h-28 w-24 rounded-lg object-cover" />
        <span className="flex items-center gap-1 text-xs">{uploading?<Spinner />:<CircleCheck className="size-4" />}{uploading?g.uploading:g.uploaded}</span>
        <span className="text-xs text-muted underline">{g.change}</span>
      </span> : <span className="flex flex-col items-center gap-2">
        <span className="grid size-10 place-items-center rounded-full bg-ink text-ink-fg"><Upload className="size-5" /></span>
        <span className="text-sm font-semibold">{g.dropTitle}</span><span className="text-xs text-muted">{g.dropHint}</span>
      </span>}
    </button>
  </div>
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <span className="grid size-5 place-items-center rounded-full bg-ink text-[11px] text-ink-fg">{n}</span>
      {children}
    </h3>
  )
}

function GenerationResult({ generation, onReset }: { generation: Generation; onReset: () => void }) {
  const g = useContent().generator
  const locale = useLocale()
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-soft p-4" data-testid="generation-status" data-status={generation.status}>
      {isActiveGeneration(generation) ? (
        <p className="flex items-start gap-2 text-sm">
          <Spinner className="mt-0.5 size-4 shrink-0" />
          {generation.pendingConfirmation ? g.pendingConfirmation : generation.status === 'queued' ? g.queued : g.processing}
        </p>
      ) : generation.status === 'succeeded' && generation.videoUrl ? (
        <>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <CircleCheck className="size-4 text-emerald-600" /> {g.succeeded}
          </p>
          <div className="relative mx-auto w-fit">
            <AiBadge />
            <video src={generation.videoUrl} controls playsInline className="max-h-[420px] rounded-lg bg-black" data-testid="generation-video" />
          </div>
          <p className="text-xs text-muted" data-testid="ai-notice">
            {g.aiNotice}
            {generation.expiresAt ? ` ${g.expiresOn(formatDate(generation.expiresAt, locale))}` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={`${generation.videoUrl}?download=1`} className="btn-primary px-4 py-2" download>
              <Download className="size-4" /> {g.download}
            </a>
            <LocalLink to="/dashboard" className="btn-ghost px-4 py-2">
              {g.viewAll}
            </LocalLink>
            <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
              {g.makeAnother}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-semibold text-red-600 dark:text-red-400">
            <CircleAlert className="size-4" /> {g.failed}
          </p>
          {generation.refunded ? <p className="text-muted">{g.refunded}</p> : null}
          <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
            {g.makeAnother}
          </button>
        </div>
      )}
    </div>
  )
}
