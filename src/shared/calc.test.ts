import { describe, expect, it, vi } from 'vitest'
import { CALC_CONSTANTS, CALC_FUNCTIONS, CALC_INPUT_MAX, calculatorRow, evaluateExpression, formatCalcNumber, isCalcCopy, type CalcFailure } from './calc'

const value = (text: string): number => {
  const outcome = evaluateExpression(text)
  if (!outcome.ok) throw new Error(`"${text}" was refused: ${outcome.reason}`)
  return outcome.value
}
const refusal = (text: string): CalcFailure | 'accepted' => {
  const outcome = evaluateExpression(text)
  return outcome.ok ? 'accepted' : outcome.reason
}

describe('evaluateExpression', () => {
  it('computes the four operations with the usual precedence', () => {
    expect(value('12*(3+4)')).toBe(84)
    expect(value('2+3*4')).toBe(14)
    expect(value('(2+3)*4')).toBe(20)
    expect(value('10-4-3')).toBe(3)
    expect(value('100/5/2')).toBe(10)
    expect(value('7 / 2')).toBe(3.5)
  })

  it('accepts the typographic operators and the sign of a negative number', () => {
    expect(value('6 × 7')).toBe(42)
    expect(value('84 ÷ 2')).toBe(42)
    expect(value('10 − 3')).toBe(7)
    expect(value('10 – 3')).toBe(7)
    expect(value('-3 + 5')).toBe(2)
    expect(value('2 * -3')).toBe(-6)
    expect(value('--4 + 1')).toBe(5)
  })

  it('reads a decimal point or a decimal comma', () => {
    expect(value('1.5+1')).toBe(2.5)
    expect(value('1,5+1')).toBe(2.5)
    expect(value('.5*4')).toBe(2)
    expect(value('3,25*4')).toBe(13)
    expect(value('1e3+1')).toBe(1001)
    expect(value('2E-2*50')).toBe(1)
  })

  it('knows that the comma separates the arguments of a call and is the decimal mark everywhere else', () => {
    expect(value('max(1,2)')).toBe(2)
    expect(value('max(1, 2, 3)')).toBe(3)
    expect(value('max(1,5)')).toBe(5)
    expect(value('max(1,5; 0,5)')).toBe(1.5)
    expect(value('max(1,5; 2)')).toBe(2)
    expect(value('max(1,5; (0,5+2))')).toBe(2.5)
    expect(value('max((1,5)*2, 2)')).toBe(3)
    expect(refusal('max(1,5; 2, 3)')).toBe('unexpected-character')
    expect(value('(1,5)*2')).toBe(3)
    expect(refusal('1,2,3')).toBe('unexpected-character')
    expect(refusal('(1,5,2)')).toBe('unexpected-character')
    expect(refusal('1;2')).toBe('unexpected-character')
    expect(refusal(',5')).toBe('unexpected-character')
  })

  it('has the power right-associative, tighter than the sign on its left and open to a sign on its right', () => {
    expect(value('2^3^2')).toBe(512)
    expect(value('2**10')).toBe(1024)
    expect(value('-2^2')).toBe(-4)
    expect(value('2^-2')).toBe(0.25)
    expect(value('(-2)^2')).toBe(4)
    expect(value('9^0.5')).toBe(3)
  })

  it('reads a percentage after a number and a remainder between two operands', () => {
    expect(value('50%')).toBe(0.5)
    expect(value('200*15%')).toBe(30)
    expect(value('-50%')).toBe(-0.5)
    expect(value('10 % 3')).toBe(1)
    expect(value('10%3')).toBe(1)
    expect(value('(10)%(4)')).toBe(2)
    expect(value('50% + 1')).toBe(1.5)
    expect(value('7 % 3 * 2')).toBe(2)
  })

  it('has the constants and the functions of the white lists', () => {
    expect(value('pi')).toBeCloseTo(Math.PI, 12)
    expect(value('π * 2')).toBeCloseTo(Math.PI * 2, 12)
    expect(value('tau')).toBeCloseTo(Math.PI * 2, 12)
    expect(value('e^1')).toBeCloseTo(Math.E, 12)
    expect(value('SQRT(16)')).toBe(4)
    expect(value('racine(81)')).toBe(9)
    expect(value('cbrt(27)')).toBe(3)
    expect(value('abs(-3)')).toBe(3)
    expect(value('sin(0)')).toBe(0)
    expect(value('cos(0)')).toBe(1)
    expect(value('atan2(1, 1)')).toBeCloseTo(Math.PI / 4, 12)
    expect(value('ln(e)')).toBe(1)
    expect(value('log(1000)')).toBeCloseTo(3, 12)
    expect(value('log2(8)')).toBe(3)
    expect(value('exp(0)')).toBe(1)
    expect(value('floor(2.7)')).toBe(2)
    expect(value('ceil(2.1)')).toBe(3)
    expect(value('round(2.5)')).toBe(3)
    expect(value('trunc(-2.7)')).toBe(-2)
    expect(value('sign(-9)')).toBe(-1)
    expect(value('deg(pi)')).toBeCloseTo(180, 12)
    expect(value('rad(180)')).toBeCloseTo(Math.PI, 12)
    expect(value('fact(5)')).toBe(120)
    expect(value('pow(2, 8)')).toBe(256)
    expect(value('min(4, 2, 9)')).toBe(2)
    expect(value('hypot(3, 4)')).toBe(5)
    expect(value('sqrt(abs(-16)) + max(1, 2)')).toBe(6)
    expect(value('-0')).toBe(0)
    expect(Object.is(value('round(-0.4)'), -0)).toBe(false)
  })

  it('lists exactly the names it documents', () => {
    expect([...CALC_FUNCTIONS].sort()).toEqual(
      ['abs', 'acos', 'asin', 'atan', 'atan2', 'cbrt', 'ceil', 'cos', 'cosh', 'deg', 'exp', 'fact', 'floor', 'hypot', 'ln', 'log', 'log2', 'max', 'min', 'pow', 'racine', 'rad', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'].sort()
    )
    expect([...CALC_CONSTANTS].sort()).toEqual(['e', 'pi', 'tau', 'π'])
  })

  it('refuses what is not an expression, saying why', () => {
    expect(refusal('')).toBe('empty')
    expect(refusal('   ')).toBe('empty')
    expect(refusal('2+')).toBe('unexpected-token')
    expect(refusal('*2')).toBe('unexpected-token')
    expect(refusal('2 3')).toBe('unexpected-token')
    expect(refusal('2(3)')).toBe('unexpected-token')
    expect(refusal('2pi')).toBe('unexpected-token')
    expect(refusal('pi(2)')).toBe('unknown-name')
    expect(refusal('sqrt')).toBe('unexpected-token')
    expect(refusal('sqrt()')).toBe('arity')
    expect(refusal('sqrt(1, 2)')).toBe('arity')
    expect(refusal('atan2(1)')).toBe('arity')
    expect(refusal('min()')).toBe('arity')
    expect(refusal('(1+2')).toBe('unbalanced')
    expect(refusal('1+2)')).toBe('unbalanced')
    expect(refusal(')(')).toBe('unbalanced')
    expect(refusal('1..2')).toBe('unexpected-character')
    expect(refusal('1.2.3')).toBe('unexpected-token')
    expect(refusal('1.')).toBe('unexpected-character')
    expect(refusal('05+1')).toBe('leading-zero')
    expect(refusal('00')).toBe('leading-zero')
    expect(refusal('0.5+1')).toBe('accepted')
  })

  it('refuses a result that is not a finite number', () => {
    expect(refusal('1/0')).toBe('division-by-zero')
    expect(refusal('0/0')).toBe('division-by-zero')
    expect(refusal('5 % 0')).toBe('division-by-zero')
    expect(refusal('sqrt(-1)')).toBe('not-finite')
    expect(refusal('(-8)^0.5')).toBe('not-finite')
    expect(refusal('ln(0)')).toBe('not-finite')
    expect(refusal('2^99999')).toBe('not-finite')
    expect(refusal('9^9^9')).toBe('not-finite')
    expect(refusal('1e999')).toBe('not-finite')
    expect(refusal('fact(171)')).toBe('not-finite')
    expect(refusal('fact(1.5)')).toBe('not-finite')
    expect(refusal('fact(-1)')).toBe('not-finite')
    expect(refusal('10^308 * 10')).toBe('not-finite')
    expect(refusal('tan(pi/2) * 1e300 * 1e300')).toBe('not-finite')
  })
})

describe('hostile texts', () => {
  const HOSTILE = [
    'constructor',
    'constructor(1)',
    '__proto__',
    '__proto__(1)',
    'toString()',
    'valueOf',
    'hasOwnProperty(1)',
    'prototype',
    'this',
    'this.constructor',
    '(1).constructor',
    '1..constructor',
    'globalThis',
    'window',
    'process',
    'process.exit()',
    'require("fs")',
    'import("fs")',
    'eval("1+1")',
    'Function("return 1")()',
    'new Function("return 1")',
    '(() => 1)()',
    'x => x',
    'alert(1)',
    'a=1',
    '1;2',
    '`1`',
    '${1+1}',
    '"1"+"1"',
    "'1'*'2'",
    '1+1//',
    '/* */1+1',
    '1+1<script>',
    '[1,2]',
    '{a:1}',
    '1 ? 2 : 3',
    '1 && 2',
    '!1',
    '~1',
    '1 | 2',
    '1 & 2',
    '1 << 2',
    '１＋１',
    '٣+٤',
    '1\u0000+1',
    '1‮+1',
    '1​+1',
    '\ud800+1',
    'Infinity',
    'NaN',
    '1+Infinity',
    'e e',
    'sin cos',
    'sin(cos',
    'sin(cos)',
    'max(,)',
    'max(1,)',
    'max(,1)',
    'max(1,,2)'
  ]

  it.each(HOSTILE)('refuses %j without throwing', (text) => {
    expect(() => evaluateExpression(text)).not.toThrow()
    expect(evaluateExpression(text).ok).toBe(false)
  })

  it('never reaches a property of Object.prototype, whatever the name', () => {
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      expect(evaluateExpression(name).ok).toBe(false)
      expect(evaluateExpression(`${name}(1)`).ok).toBe(false)
    }
    for (const name of ['name', 'length', 'call', 'apply', 'bind', 'caller', 'arguments', 'then']) {
      expect(evaluateExpression(`${name}(1)`).ok).toBe(false)
    }
  })

  it('does not run a thing: a global set by the text stays unset', () => {
    const globals = globalThis as unknown as Record<string, unknown>
    for (const text of ['(globalThis.__calc_pwn = 1)', 'globalThis.__calc_pwn = 1', '__calc_pwn = 1', 'eval("globalThis.__calc_pwn = 1")', 'Function("globalThis.__calc_pwn = 1")()']) {
      evaluateExpression(text)
    }
    expect(globals['__calc_pwn']).toBeUndefined()
  })

  it('refuses a text that is too long before reading it', () => {
    expect(refusal('1+'.repeat(CALC_INPUT_MAX / 2 + 1))).toBe('too-long')
    expect(refusal('9'.repeat(CALC_INPUT_MAX + 1))).toBe('too-long')
    expect(refusal('1+'.repeat(59) + '1')).toBe('accepted')
  })

  it('refuses a very long list of operands before its time runs out', () => {
    expect(refusal('1+'.repeat(65) + '1')).toBe('too-many-tokens')
  })

  it('refuses a deep nesting instead of overflowing the stack', () => {
    expect(refusal('('.repeat(60) + '1' + ')'.repeat(60))).toBe('too-deep')
    expect(refusal('-'.repeat(100) + '1')).toBe('too-deep')
    expect(refusal('ln('.repeat(45) + '1' + ')'.repeat(45))).toBe('too-deep')
    expect(refusal('-('.repeat(38) + '1' + ')'.repeat(38))).toBe('too-deep')
    expect(refusal('2^'.repeat(60) + '2')).toBe('too-many-tokens')
    expect(refusal('('.repeat(30) + '1' + ')'.repeat(30))).toBe('accepted')
    expect(refusal('-'.repeat(30) + '1')).toBe('accepted')
    expect(refusal('-('.repeat(20) + '1' + ')'.repeat(20))).toBe('accepted')
  })

  it('refuses a call with too many arguments', () => {
    expect(refusal(`max(${Array.from({ length: 17 }, () => '1').join(',')})`)).toBe('arity')
    expect(refusal(`max(${Array.from({ length: 16 }, () => '1').join(',')})`)).toBe('accepted')
  })

  it('is quick on the worst inputs it accepts', () => {
    const started = Date.now()
    for (let i = 0; i < 300; i++) {
      evaluateExpression('((((((((((1+2)*3)-4)/5)^2)%7)+8)*9)-10)/11)'.repeat(2).slice(0, 150))
      evaluateExpression('2^'.repeat(50) + '2')
      evaluateExpression('9'.repeat(190))
    }
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('never calls eval or the Function constructor, for the texts it accepts as for the ones it refuses', () => {
    const globals = globalThis as unknown as Record<string, unknown>
    const real = { eval: globals['eval'], Function: globals['Function'] }
    const called: string[] = []
    globals['eval'] = () => void called.push('eval')
    globals['Function'] = function () {
      called.push('Function')
    }
    try {
      for (const text of ['12*(3+4)', 'sqrt(16) + max(1, 2)', '50%', '2^10', ...HOSTILE]) evaluateExpression(text)
    } finally {
      globals['eval'] = real.eval
      globals['Function'] = real.Function
    }
    expect(called).toEqual([])
  })

  it('reports an exception that is not a refusal of its own, and refuses the text all the same', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // `power` calls Math.pow when it computes: a failure there is not one of the parser's refusals.
    const pow = vi.spyOn(Math, 'pow').mockImplementation(() => {
      throw new RangeError('boom')
    })
    const outcome = evaluateExpression('2^3')
    pow.mockRestore()
    expect(outcome).toEqual({ ok: false, reason: 'not-finite' })
    expect(warn).toHaveBeenCalledWith('[calc] the expression could not be evaluated:', 'boom')
    warn.mockRestore()
  })
})

describe('formatCalcNumber', () => {
  it('rounds to twelve significant digits', () => {
    expect(formatCalcNumber(0.1 + 0.2, false, false)).toBe('0.3')
    expect(formatCalcNumber(1 / 3, false, false)).toBe('0.333333333333')
    expect(formatCalcNumber(100, false, false)).toBe('100')
    expect(formatCalcNumber(-2.5, false, false)).toBe('-2.5')
  })

  it('follows the decimal mark the user typed', () => {
    expect(formatCalcNumber(2.5, true, false)).toBe('2,5')
    expect(formatCalcNumber(2.5, false, false)).toBe('2.5')
  })

  it('groups the thousands of a long number for the display, from five digits', () => {
    expect(formatCalcNumber(1234, false, true)).toBe('1234')
    expect(formatCalcNumber(12345, false, true)).toBe('12 345')
    expect(formatCalcNumber(-1234567.5, true, true)).toBe('-1 234 567,5')
    expect(formatCalcNumber(1234567, false, false)).toBe('1234567')
  })

  it('keeps a very large or very small number readable', () => {
    expect(formatCalcNumber(2 ** 60, false, false)).toBe('1.15292150461e18')
    expect(formatCalcNumber(1e-9, false, false)).toBe('1e-9')
    expect(formatCalcNumber(1.5e21, true, true)).toBe('1,5e21')
  })
})

describe('calculatorRow', () => {
  it('gives the answer, a copy without grouping, and the tidied text', () => {
    expect(calculatorRow('  12 * ( 3 + 4 ) ')).toEqual({ display: '84', copy: '84', expression: '12 * ( 3 + 4 )' })
    expect(calculatorRow('1000*1000')).toEqual({ display: '1 000 000', copy: '1000000', expression: '1000*1000' })
    expect(calculatorRow('7/2,0')).toEqual({ display: '3,5', copy: '3,5', expression: '7/2,0' })
    expect(calculatorRow('sqrt(2)')?.copy).toBe('1.41421356237')
  })

  it('has nothing for what is not a calculation', () => {
    for (const text of ['', '42', '-5', '(5)', '3,14', 'pi', 'e', 'hello', 'a+b', '2026-10-24', '24/10/2026', '1/2/2026', '10.0.0.1', '01 23 45 67', 'github.com/a+b', '1+', 'sqrt(-1)', '1/0']) {
      expect(calculatorRow(text), text).toBeNull()
    }
  })

  it('keeps a subtraction that is not a date', () => {
    expect(calculatorRow('3-4')?.copy).toBe('-1')
    expect(calculatorRow('2026-10')?.copy).toBe('2016')
  })
})

describe('isCalcCopy', () => {
  it('accepts a number as the calculator writes it and nothing else', () => {
    for (const ok of ['84', '-1', '3,5', '1.41421356237', '1e-9', '1.5e21', '0']) expect(isCalcCopy(ok), ok).toBe(true)
    for (const bad of ['', ' 84', '84 ', '1 000', '1 000', 'NaN', 'Infinity', '1+1', '=84', 'abc', '9'.repeat(41), '1e', '--1', 42, null, undefined, {}]) expect(isCalcCopy(bad), String(bad)).toBe(false)
  })
})
