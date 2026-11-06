import bridge = require('@lp-labs/design-token-bridge');

const color = bridge.parseHexColor('#ffffff');
const channels: readonly [number, number, number, number] = color;
console.log(channels[0]);
