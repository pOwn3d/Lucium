import { describe, expect, it } from 'vitest'
import { blockerIsOn } from './blocker'
import { FEATURES, featureById, featurePatch, isFeatureOn, type Feature, type FeatureId } from './features'
import { defaultSettings } from './model'
import { COST_CLASS_PERF, featuresWithoutCostClass, PERF_SKIPPED, perfFeaturePatch } from './perf-features'

const all: readonly Feature[] = FEATURES
const settingsWith = (patch: object) => ({ ...defaultSettings(), ...patch })

describe('the cost classes', () => {
  it('give every feature of the registry a class that the measures know', () => {
    expect(featuresWithoutCostClass(FEATURES), 'fonction sans classe de coût connue de pnpm perf (src/shared/perf-features.ts, COST_CLASS_PERF)').toEqual([])
  })

  it('name the feature whose cost is empty, or is a class nobody described', () => {
    expect(featuresWithoutCostClass([{ id: 'sans-cout', cost: [] }])).toEqual(['sans-cout'])
    expect(featuresWithoutCostClass([{ id: 'classe-inconnue', cost: ['none', 'gpu'] }])).toEqual(['classe-inconnue'])
    expect(featuresWithoutCostClass([{ id: 'prototype', cost: ['constructor'] }])).toEqual(['prototype'])
    expect(featuresWithoutCostClass([{ id: 'ok', cost: ['timer', 'memory'] }, { id: 'aussi', cost: ['none'] }])).toEqual([])
  })

  it('say, for each class, whether the scenarios see it, and why', () => {
    for (const [name, perf] of Object.entries(COST_CLASS_PERF)) {
      expect(['yes', 'partly', 'no'], name).toContain(perf.seen)
      expect(perf.how.length, name).toBeGreaterThan(30)
    }
    // The report must not promise what it does not look at: no Internet in the measures, no disk.
    expect(COST_CLASS_PERF.network.seen).toBe('no')
    expect(COST_CLASS_PERF.disk.seen).toBe('no')
  })
})

describe('the features left aside by “toutes allumées”', () => {
  it('are registered, and each has a reason', () => {
    for (const [id, reason] of Object.entries(PERF_SKIPPED)) {
      expect(all.some((feature) => feature.id === id), `${id} n’est pas au registre`).toBe(true)
      expect(reason?.length, id).toBeGreaterThan(40)
    }
  })

  it('stay few: a scenario that leaves out half the registry no longer measures “toutes allumées”', () => {
    expect(Object.keys(PERF_SKIPPED).length).toBeLessThanOrEqual(5)
  })
})

describe('perfFeaturePatch', () => {
  it('switches every registered feature off, and writes nothing else', () => {
    const { patch, on, off } = perfFeaturePatch('off')
    expect(Object.keys(patch).sort()).toEqual([...new Set(all.flatMap((feature) => Object.keys(featurePatch(feature.id as FeatureId, false))))].sort())
    const settings = settingsWith(patch)
    // The blocker is really off, alias included: a measure of "everything off" with the lists still applied would be a measure of the blocker.
    expect(patch).toMatchObject({ blockAds: false, blockTrackers: false, blockCookieBanners: false })
    expect(blockerIsOn(settings)).toBe(false)
    expect(FEATURES.filter((feature) => isFeatureOn(settings, feature.id)).map((feature) => feature.id)).toEqual([])
    expect(on).toEqual([])
    expect(off).toHaveLength(all.length)
  })

  it('switches every registered feature on, but the ones it leaves aside, which it switches off', () => {
    const { patch, on, off } = perfFeaturePatch('on')
    const settings = settingsWith(patch)
    const skipped = Object.keys(PERF_SKIPPED)
    expect(FEATURES.filter((feature) => !isFeatureOn(settings, feature.id)).map((feature) => feature.id).sort()).toEqual([...skipped].sort())
    expect([...off].sort()).toEqual([...skipped].sort())
    expect(on).toHaveLength(all.length - skipped.length)
    expect(new Set([...on, ...off]).size).toBe(all.length)
  })

  it('starts the features whose delay is 0 by default with a delay above 0', () => {
    const thresholds = all.filter((feature) => feature.kind === 'threshold')
    expect(thresholds.length).toBeGreaterThan(0)
    const settings = settingsWith(perfFeaturePatch('on').patch) as unknown as Record<string, number>
    for (const feature of thresholds) expect(settings[feature.key], feature.id).toBeGreaterThan(0)
  })

  it('does not touch a setting that is not a feature', () => {
    const features = new Set<string>(all.flatMap((feature) => Object.keys(featurePatch(feature.id as FeatureId, true))))
    for (const mode of ['on', 'off'] as const) for (const key of Object.keys(perfFeaturePatch(mode).patch)) expect(features.has(key), key).toBe(true)
    expect(featureById('sleep').key).toBe('sleepAfterMinutes')
  })
})
