import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sameWorkflowApartFromPin } from './workflow-text.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const template = readFileSync(path.join(ROOT, 'templates', 'workflows', 'review-gate.yml'), 'utf8')
const fill = (pin) => template.replaceAll('v{{STEWARD_VERSION}}', () => pin)

describe('ST-79/AC-1: a workflow is a template with only the pin different', () => {
  it('ST-79/AC-1: a template filled with two different pins matches, and matches the template itself', () => {
    expect(sameWorkflowApartFromPin(fill('v0.1.0'), fill('v9.9.9'))).toBe(true)
    expect(sameWorkflowApartFromPin(fill('0123456789abcdef0123456789abcdef01234567'), fill('v0.1.0'))).toBe(true)
    expect(sameWorkflowApartFromPin(fill('v0.1.0'), template)).toBe(true)
  })

  it('ST-79/AC-1: line endings are ignored', () => {
    expect(sameWorkflowApartFromPin(fill('v0.1.0').replaceAll('\n', '\r\n'), fill('v0.2.0'))).toBe(true)
  })

  it('ST-79/AC-1: one other line changed, added or removed does not match', () => {
    const text = fill('v0.1.0')
    const lines = text.split('\n')
    const index = lines.findIndex((line) => line.startsWith('name:'))
    expect(index).toBeGreaterThanOrEqual(0)
    const changed = lines.map((line, i) => (i === index ? `${line} (mine)` : line)).join('\n')
    expect(sameWorkflowApartFromPin(changed, text)).toBe(false)
    expect(sameWorkflowApartFromPin(`${text}# more\n`, text)).toBe(false)
    expect(sameWorkflowApartFromPin(lines.filter((_, i) => i !== index).join('\n'), text)).toBe(false)
    expect(sameWorkflowApartFromPin(text.replace('github:luplows/steward#', 'github:someone/else#'), text)).toBe(false)
  })
})
