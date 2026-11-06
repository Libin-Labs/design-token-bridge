import { mapDesignTokens, convertSpacing, type DesignTokenSet } from '@lp-labs/design-token-bridge';

const tokens: DesignTokenSet = {
  'space.small': { type: 'dimension', value: '8px' },
};
const mapped = mapDesignTokens(tokens, {
  nameMap: { 'space.small': 'spacing.1' },
});
const spacing: string = convertSpacing('32px', { from: 'px', to: 'rem' });
console.log(mapped.tokens['spacing.1'], spacing);
