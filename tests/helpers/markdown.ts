import { dirname, resolve } from 'node:path'

export function localMarkdownTargets(sourcePath: string, source: string): string[] {
  return [...source.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ''))
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .map((target) => target.split('#')[0])
    .filter(Boolean)
    .map((target) => resolve(dirname(sourcePath), target))
}
