import { describe, expect, it } from 'vitest'
import { addressForSummary } from './summary-prompt'

describe('the address given to the model with a summary', () => {
  it('keeps the origin and the path, and drops the query and the fragment', () => {
    expect(addressForSummary('https://exemple.fr/article/12?token=SECRET&q=x#section')).toBe('https://exemple.fr/article/12')
  })

  it('gives nothing for an address that is not one', () => {
    expect(addressForSummary('pas une adresse')).toBe('')
  })
})
