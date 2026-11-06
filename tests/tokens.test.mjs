import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  resolveTokenAliases,
  mapDesignTokens,
  diffDesignTokens,
  parseHexColor,
  formatHexColor,
  convertSpacing,
  TokenBridgeError,
} from '../dist/esm/index.js';

test('resolves literal tokens and returns detached values', () => {
  const source = { color: { type: 'color', value: { hex: '#fff' } } };
  const resolved = resolveTokenAliases(source);
  source.color.value.hex = '#000';
  assert.deepEqual(resolved, {
    color: { type: 'color', value: { hex: '#fff' } },
  });
});

test('resolves chains of same-type aliases and detects unresolved targets', () => {
  const tokens = {
    'color.base': { type: 'color', value: '#f00' },
    'color.primary': { type: 'color', value: null, alias: 'color.base' },
    'color.action': { type: 'color', value: null, alias: 'color.primary' },
  };
  assert.deepEqual(resolveTokenAliases(tokens)['color.action'], {
    type: 'color',
    value: '#f00',
  });
  assert.throws(
    () =>
      resolveTokenAliases({
        missing: { type: 'color', value: null, alias: 'absent' },
      }),
    (error) => error instanceof TokenBridgeError && error.code === 'ALIAS_MISSING',
  );
});

test('reports direct and indirect alias cycles', () => {
  for (const tokens of [
    { a: { type: 'color', value: null, alias: 'a' } },
    {
      a: { type: 'color', value: null, alias: 'b' },
      b: { type: 'color', value: null, alias: 'c' },
      c: { type: 'color', value: null, alias: 'a' },
    },
  ]) {
    assert.throws(() => resolveTokenAliases(tokens), { code: 'ALIAS_CYCLE' });
  }
});

test('resolves long alias chains iteratively within token-count bounds', () => {
  const tokens = { base: { type: 'color', value: '#fff' } };
  for (let index = 0; index < 5_000; index += 1) {
    tokens[`alias.${index}`] = {
      type: 'color',
      value: null,
      alias: index === 0 ? 'base' : `alias.${index - 1}`,
    };
  }
  const resolved = resolveTokenAliases(tokens);
  assert.equal(resolved['alias.4999'].value, '#fff');
});

test('requires aliases to use a null placeholder and match target type', () => {
  assert.throws(
    () =>
      resolveTokenAliases({
        alias: { type: 'color', value: '#fff', alias: 'base' },
        base: { type: 'color', value: '#000' },
      }),
    { code: 'INVALID_TOKEN' },
  );
  assert.throws(
    () =>
      resolveTokenAliases({
        alias: { type: 'space', value: null, alias: 'base' },
        base: { type: 'color', value: '#000' },
      }),
    { code: 'INVALID_TOKEN' },
  );
});

test('maps token names, semantic types, and injected value transforms', () => {
  const mapped = mapDesignTokens(
    {
      'space.small': { type: 'dimension', value: '8px' },
      'color.action': { type: 'color', value: '#fff' },
    },
    {
      nameMap: { 'space.small': 'spacing.1' },
      typeMap: { dimension: 'spacing' },
      transforms: {
        color(token) {
          return { type: token.type, value: String(token.value).toLowerCase() };
        },
      },
    },
  );
  assert.deepEqual(mapped.tokens, {
    'spacing.1': { type: 'spacing', value: '8px' },
    'color.action': { type: 'color', value: '#fff' },
  });
  assert.deepEqual(mapped.diagnostics, [
    { kind: 'added', name: 'spacing.1' },
    { kind: 'added', name: 'color.action' },
  ]);
});

test('rejects mapped-name collisions and unsafe target names', () => {
  assert.throws(
    () =>
      mapDesignTokens(
        {
          a: { type: 'color', value: '#fff' },
          b: { type: 'color', value: '#000' },
        },
        { nameMap: { a: 'same', b: 'same' } },
      ),
    { code: 'NAME_COLLISION' },
  );
  assert.throws(
    () =>
      mapDesignTokens(
        {
          a: { type: 'color', value: '#fff' },
        },
        { nameMap: { a: '__proto__' } },
      ),
    { code: 'INVALID_TOKEN' },
  );
});

test('rejects invalid transform results and isolates thrown exception details', () => {
  assert.throws(
    () =>
      mapDesignTokens(
        { a: { type: 'color', value: '#fff' } },
        {
          transforms: {
            color() {
              return { type: 7, value: 1 };
            },
          },
        },
      ),
    { code: 'INVALID_TRANSFORM' },
  );
  assert.throws(
    () =>
      mapDesignTokens(
        { a: { type: 'color', value: '#fff' } },
        {
          transforms: {
            color() {
              throw new Error('secret transform failure');
            },
          },
        },
      ),
    (error) => error.code === 'INVALID_TRANSFORM' && !error.message.includes('secret'),
  );
  let inheritedCalls = 0;
  const inheritedTransforms = Object.create({
    color: () => {
      inheritedCalls += 1;
      return { type: 'color', value: '#000' };
    },
  });
  assert.throws(
    () =>
      mapDesignTokens(
        { color: { type: 'color', value: '#fff' } },
        { transforms: inheritedTransforms },
      ),
    { code: 'INVALID_TOKEN' },
  );
  assert.equal(inheritedCalls, 0);
});

test('computes deterministic added, removed, value, and type change diagnostics', () => {
  const before = {
    keep: { type: 'color', value: '#fff' },
    change: { type: 'dimension', value: '4px' },
    remove: { type: 'font', value: 'Serif' },
  };
  const after = {
    keep: { type: 'color', value: '#fff' },
    change: { type: 'spacing', value: '8px' },
    add: { type: 'color', value: '#000' },
  };
  assert.deepEqual(diffDesignTokens(before, after), [
    { kind: 'changed', name: 'change', fields: ['type', 'value'] },
    { kind: 'removed', name: 'remove' },
    { kind: 'added', name: 'add' },
  ]);
});

test('returns no diagnostics for equivalent tokens and handles empty sets', () => {
  assert.deepEqual(diffDesignTokens({}, {}), []);
  assert.deepEqual(
    diffDesignTokens(
      { a: { type: 'color', value: '#fff' } },
      { a: { type: 'color', value: '#fff' } },
    ),
    [],
  );
});

test('compares structural JSON values independent of property insertion order', () => {
  const before = { token: { type: 'shadow', value: { x: 1, y: 2 } } };
  const after = { token: { type: 'shadow', value: { y: 2, x: 1 } } };
  assert.deepEqual(diffDesignTokens(before, after), []);
});

test('parses short and long hex colors with implicit or explicit alpha', () => {
  assert.deepEqual(parseHexColor('#f0a'), [255, 0, 170, 255]);
  assert.deepEqual(parseHexColor('#f0a8'), [255, 0, 170, 136]);
  assert.deepEqual(parseHexColor('#102030'), [16, 32, 48, 255]);
  assert.deepEqual(parseHexColor('#10203040'), [16, 32, 48, 64]);
});

test('formats RGB and RGBA channels with range validation', () => {
  assert.equal(formatHexColor([16, 32, 48]), '#102030');
  assert.equal(formatHexColor([16, 32, 48, 64]), '#10203040');
  for (const color of [
    [-1, 0, 0],
    [256, 0, 0],
    [1.5, 0, 0],
  ]) {
    assert.throws(() => formatHexColor(color), RangeError);
  }
  assert.throws(() => formatHexColor([1, 2]), TypeError);
  const getterColor = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      throw new Error('channel getter must not run');
    },
  });
  getterColor.length = 3;
  assert.throws(() => formatHexColor(getterColor), TypeError);
  const extraColor = [1, 2, 3];
  extraColor.extra = true;
  assert.throws(() => formatHexColor(extraColor), TypeError);
});

test('rejects named colors, malformed hex, and invalid input types', () => {
  for (const value of ['red', '#12', '#abcdx', '##fff', 1, null]) {
    assert.throws(() => parseHexColor(value), TypeError);
  }
});

test('converts px and rem dimensions and preserves units for identity conversion', () => {
  assert.equal(convertSpacing('32px', { from: 'px', to: 'rem' }), '2rem');
  assert.equal(convertSpacing('1.5rem', { from: 'rem', to: 'px', rootFontSize: 10 }), '15px');
  assert.equal(convertSpacing(12, { from: 'px', to: 'rem', rootFontSize: 6 }), 2);
  assert.equal(convertSpacing('8px', { from: 'px', to: 'px' }), '8px');
});

test('rejects unsupported spacing text, nonfinite values, and bad root font sizes', () => {
  for (const value of ['8em', 'auto', '12px ']) {
    assert.throws(() => convertSpacing(value, { from: 'px', to: 'rem' }), TypeError);
  }
  assert.throws(() => convertSpacing(Infinity, { from: 'px', to: 'rem' }), TypeError);
  for (const rootFontSize of [0, -1, Infinity, NaN]) {
    assert.throws(
      () =>
        convertSpacing('8px', {
          from: 'px',
          to: 'rem',
          rootFontSize,
        }),
      RangeError,
    );
  }
  assert.throws(() => convertSpacing('auto', { from: 'px', to: 'px' }), TypeError);
  assert.throws(() => convertSpacing('8em', { from: 'em', to: 'em' }), TypeError);
});

test('enforces token count, name, value node, depth, and string bounds', () => {
  assert.throws(
    () =>
      resolveTokenAliases(
        {
          a: { type: 'color', value: '#fff' },
          b: { type: 'color', value: '#000' },
        },
        { maxTokens: 1 },
      ),
    { code: 'LIMIT_EXCEEDED' },
  );
  assert.throws(
    () =>
      resolveTokenAliases(
        {
          long: { type: 'color', value: '#fff' },
        },
        { maxNameLength: 3 },
      ),
    { code: 'INVALID_TOKEN_SET' },
  );
  assert.throws(
    () =>
      resolveTokenAliases(
        {
          a: { type: 'data', value: { child: 1 } },
        },
        { maxNodes: 1 },
      ),
    { code: 'LIMIT_EXCEEDED' },
  );
  assert.throws(
    () =>
      resolveTokenAliases(
        {
          a: { type: 'data', value: { child: 1 } },
        },
        { maxDepth: 0 },
      ),
    { code: 'LIMIT_EXCEEDED' },
  );
  assert.throws(
    () =>
      resolveTokenAliases(
        {
          a: { type: 'data', value: 'long' },
        },
        { maxStringLength: 3 },
      ),
    { code: 'LIMIT_EXCEEDED' },
  );
});

test('rejects invalid bounds, malformed token shape, and prototype token keys', () => {
  assert.throws(() => resolveTokenAliases({}, { maxTokens: 0 }), {
    code: 'LIMIT_EXCEEDED',
  });
  assert.throws(() => resolveTokenAliases({ a: { value: 1 } }), {
    code: 'INVALID_TOKEN',
  });
  assert.throws(
    () => resolveTokenAliases(JSON.parse('{"__proto__":{"type":"color","value":"x"}}')),
    {
      code: 'INVALID_TOKEN_SET',
    },
  );
});

test('rejects cycles, undefined, sparse arrays, accessors, symbols, and class instances', () => {
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse[1] = 'x';
  const accessor = Object.defineProperty({}, 'x', {
    enumerable: true,
    get: () => 1,
  });
  class Custom {
    value = 1;
  }
  for (const value of [cycle, undefined, sparse, accessor, new Custom(), { [Symbol('s')]: 1 }]) {
    assert.throws(() => resolveTokenAliases({ a: { type: 'data', value } }));
  }
});

test('rejects unknown token fields and non-enumerable token descriptors', () => {
  assert.throws(
    () =>
      resolveTokenAliases({
        a: { type: 'color', value: '#fff', description: 'unmodeled' },
      }),
    { code: 'INVALID_TOKEN' },
  );
  const tokenSet = Object.defineProperty({}, 'a', {
    value: { type: 'color', value: '#fff' },
  });
  assert.throws(() => resolveTokenAliases(tokenSet), {
    code: 'INVALID_TOKEN_SET',
  });
});

test('CommonJS entry point exposes resolution and color conversion', () => {
  const require = createRequire(import.meta.url);
  const commonjs = require('../dist/cjs/index.js');
  assert.equal(
    commonjs.resolveTokenAliases({ a: { type: 'color', value: '#abc' } }).a.value,
    '#abc',
  );
  assert.equal(commonjs.formatHexColor([0, 0, 0]), '#000000');
});
