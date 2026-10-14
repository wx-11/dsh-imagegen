/** Normalize the public image-prompts registry without losing upstream credits. */
export function registrySnapshot(payload: unknown) {
  if (!Array.isArray(payload)) throw new Error('提示词注册表格式无效')
  const cases = payload.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.prompt !== 'string' || !raw.prompt.trim()
      || typeof raw.id !== 'string' || typeof raw.title !== 'string') return []
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag: unknown) => typeof tag === 'string') : []
    return [{
      id: raw.id, title: raw.title, prompt: raw.prompt,
      category: tags[0] ?? 'Other', categoryZh: tags[0] ?? '其他', styles: tags, scenes: [],
      sourceLabel: [raw.sourceId, raw.author].filter(Boolean).join(' · '),
      sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
      githubUrl: 'https://github.com/yukkcat/image-prompts',
      image: typeof raw.coverUrl === 'string' ? raw.coverUrl : '', featured: false,
    }]
  })
  if (!cases.length) throw new Error('提示词注册表为空')
  return { repository: 'yukkcat/image-prompts', cases }
}

/** Literal, case-insensitive matching in the two searchable fields only. */
export function matchesTemplate(item: { title: string; prompt: string }, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || item.title.toLowerCase().includes(needle) || item.prompt.toLowerCase().includes(needle)
}
