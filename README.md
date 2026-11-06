# @lp-labs/design-token-bridge

Resolve and map bounded, flat design-token records, convert common color and spacing values, and
report token-set changes. The accepted token shape is this package's small local TypeScript API; it
does not claim compatibility with any external design-token schema.

## Install and quick start

```sh
npm install @lp-labs/design-token-bridge
```

```js
import { mapDesignTokens, convertSpacing, parseHexColor } from '@lp-labs/design-token-bridge';

const source = {
  'color.brand': { type: 'color', value: '#1a2b3c' },
  'space.small': { type: 'dimension', value: '8px' },
  'color.action': { type: 'color', value: null, alias: 'color.brand' },
};
const mapped = mapDesignTokens(source, {
  nameMap: { 'space.small': 'spacing.1' },
  typeMap: { dimension: 'spacing' },
});
console.log(mapped.tokens['color.action'], parseHexColor('#1a2b3c'));
console.log(convertSpacing('32px', { from: 'px', to: 'rem', rootFontSize: 16 }));
```

## API and types

- `resolveTokenAliases(tokens, limits?)` returns detached resolved `{ type, value }` entries.
  Aliases use `{ type, value: null, alias: 'target.name' }` and must match the target type.
- `mapDesignTokens(tokens, options?)` resolves aliases, applies explicit `nameMap`, `typeMap`, and
  optional injected transforms keyed by the original token type, and returns mapped tokens plus
  `added` diagnostics.
- `diffDesignTokens(before, after, limits?)` reports `added`, `removed`, and `changed` entries; a
  change lists either or both `type` and `value`.
- `parseHexColor(text)` parses `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA` into RGBA byte channels.
- `formatHexColor(channels)` formats RGB or RGBA byte channels.
- `convertSpacing(value, conversion)` converts numeric values or explicit `px`/`rem` strings.
  `rootFontSize` defaults to 16 for cross-unit conversion.
- `TokenBridgeError` provides stable error codes for invalid input, missing aliases, cycles,
  collisions, transform failures, and bound violations: `INVALID_TOKEN_SET`, `INVALID_TOKEN`,
  `ALIAS_MISSING`, `ALIAS_CYCLE`, `NAME_COLLISION`, `LIMIT_EXCEEDED`, and `INVALID_TRANSFORM`.
- Types: `JsonValue`, `DesignToken`, `DesignTokenSet`, `ResolvedToken`, `ResolvedTokenSet`,
  `TokenBridgeLimits`, `TokenChange`, `TokenMapOptions`, and `SpacingConversion`.

Limits default to 10,000 tokens, 256 characters per name, depth 32, 10,000 JSON nodes, and 100,000
characters per string. Missing targets, alias cycles, and type-mismatched aliases fail with
diagnostic error codes. Mapping collisions fail instead of overwriting. Color helpers accept hex
only (not CSS names or functions); spacing conversion supports only px and rem and does not infer a
font size. Resolution, mapping, and diffing are linear in the token count plus the copied JSON
values; alias traversal is bounded by the number of input tokens and each value by its node/depth
limits. No runtime or peer dependencies are used.

## Module formats and customization

ESM, CommonJS, and TypeScript declarations are included. CommonJS:
`const { resolveTokenAliases } = require('@lp-labs/design-token-bridge')`. Add explicit
source-specific conversions using trusted injected transforms, and run `diffDesignTokens` before
applying updates. There are no runtime or peer dependencies; TypeScript and Prettier are
development-only.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
