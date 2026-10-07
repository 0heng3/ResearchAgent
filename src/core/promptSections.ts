type ComputePromptSection = () => string | null

type PromptSection = {
  name: string
  compute: ComputePromptSection
  cacheBreak: boolean
}

const sectionCache = new Map<string, string | null>()

export function promptSection(name: string, compute: ComputePromptSection): PromptSection {
  return {
    name,
    compute,
    cacheBreak: false,
  }
}

export function volatilePromptSection(name: string, compute: ComputePromptSection): PromptSection {
  return {
    name,
    compute,
    cacheBreak: true,
  }
}

export function resolvePromptSections(sections: PromptSection[]) {
  return sections
    .map(section => {
      if (!section.cacheBreak && sectionCache.has(section.name)) {
        return sectionCache.get(section.name) ?? null
      }
      const value = section.compute()
      sectionCache.set(section.name, value)
      return value
    })
    .filter((section): section is string => Boolean(section))
}

export function clearPromptSectionCache() {
  sectionCache.clear()
}
