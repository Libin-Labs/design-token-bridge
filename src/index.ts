export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface DesignToken {
  readonly type: string;
  readonly value: JsonValue;
  readonly alias?: string;
}

export type DesignTokenSet = Readonly<Record<string, DesignToken>>;
export type ResolvedToken = Readonly<{ type: string; value: JsonValue }>;
export type ResolvedTokenSet = Readonly<Record<string, ResolvedToken>>;

export interface TokenBridgeLimits {
  readonly maxTokens?: number;
  readonly maxNameLength?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxStringLength?: number;
}

export interface TokenChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly name: string;
  readonly fields?: readonly ('type' | 'value')[];
}

export interface TokenMapOptions {
  readonly nameMap?: Readonly<Record<string, string>>;
  readonly typeMap?: Readonly<Record<string, string>>;
  readonly transforms?: Readonly<Record<string, (token: ResolvedToken) => ResolvedToken>>;
  readonly limits?: TokenBridgeLimits;
}

export class TokenBridgeError extends Error {
  readonly code:
    | 'INVALID_TOKEN_SET'
    | 'INVALID_TOKEN'
    | 'ALIAS_MISSING'
    | 'ALIAS_CYCLE'
    | 'NAME_COLLISION'
    | 'LIMIT_EXCEEDED'
    | 'INVALID_TRANSFORM';
  readonly token?: string;

  constructor(code: TokenBridgeError['code'], message: string, token?: string) {
    super(message);
    this.name = 'TokenBridgeError';
    this.code = code;
    if (token !== undefined) this.token = token;
  }
}

const defaults = {
  maxTokens: 10_000,
  maxNameLength: 256,
  maxDepth: 32,
  maxNodes: 10_000,
  maxStringLength: 100_000,
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function limitsOf(input: TokenBridgeLimits = {}) {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    throw new TokenBridgeError('LIMIT_EXCEEDED', 'Token limits must be a plain record.');
  }
  const allowed = new Set([
    'maxTokens',
    'maxNameLength',
    'maxDepth',
    'maxNodes',
    'maxStringLength',
  ]);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor =
      typeof key === 'string' ? Object.getOwnPropertyDescriptor(input, key) : undefined;
    if (
      !descriptor ||
      !allowed.has(key as string) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new TokenBridgeError('LIMIT_EXCEEDED', 'Token limits contain unknown fields.');
    }
  }
  const limits = {
    maxTokens: input.maxTokens ?? defaults.maxTokens,
    maxNameLength: input.maxNameLength ?? defaults.maxNameLength,
    maxDepth: input.maxDepth ?? defaults.maxDepth,
    maxNodes: input.maxNodes ?? defaults.maxNodes,
    maxStringLength: input.maxStringLength ?? defaults.maxStringLength,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxDepth' ? 0 : 1)) {
      throw new TokenBridgeError('LIMIT_EXCEEDED', `${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function copyJson(input: unknown, limits: ReturnType<typeof limitsOf>, token: string): JsonValue {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) {
      throw new TokenBridgeError('LIMIT_EXCEEDED', 'Token value exceeds JSON capacity.', token);
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > limits.maxStringLength) {
        throw new TokenBridgeError('LIMIT_EXCEEDED', 'Token string exceeds capacity.', token);
      }
      return value;
    }
    if (typeof value !== 'object' || active.has(value)) {
      throw new TokenBridgeError(
        'INVALID_TOKEN',
        'Token value must be finite JSON without cycles.',
        token,
      );
    }
    active.add(value);
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TokenBridgeError(
            'INVALID_TOKEN',
            'Token arrays must be dense data arrays.',
            token,
          );
        }
        result.push(visit(descriptor.value, depth + 1));
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) {
          throw new TokenBridgeError(
            'INVALID_TOKEN',
            'Token arrays cannot have extra properties.',
            token,
          );
        }
      }
      active.delete(value);
      return result;
    }
    if (!isRecord(value)) {
      throw new TokenBridgeError('INVALID_TOKEN', 'Token objects must be plain records.', token);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TokenBridgeError(
          'INVALID_TOKEN',
          'Token objects cannot have symbol keys.',
          token,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TokenBridgeError(
          'INVALID_TOKEN',
          'Token objects must use enumerable data fields.',
          token,
        );
      }
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    active.delete(value);
    return result;
  };
  return visit(input, 0);
}

function tokenEntries(
  input: unknown,
  limits: ReturnType<typeof limitsOf>,
): Map<string, DesignToken> {
  if (!isRecord(input)) {
    throw new TokenBridgeError('INVALID_TOKEN_SET', 'Token set must be a plain record.');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > limits.maxTokens) {
    throw new TokenBridgeError('LIMIT_EXCEEDED', 'Token count exceeds capacity.');
  }
  const entries = new Map<string, DesignToken>();
  for (const key of keys) {
    const descriptor =
      typeof key === 'string' ? Object.getOwnPropertyDescriptor(input, key) : undefined;
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > limits.maxNameLength ||
      forbidden.has(key) ||
      !descriptor?.enumerable ||
      !('value' in descriptor) ||
      !isRecord(descriptor.value)
    ) {
      throw new TokenBridgeError(
        'INVALID_TOKEN_SET',
        'Token names and entries must be safe records.',
      );
    }
    const raw = descriptor.value;
    for (const field of Reflect.ownKeys(raw)) {
      const fieldDescriptor =
        typeof field === 'string' ? Object.getOwnPropertyDescriptor(raw, field) : undefined;
      if (
        typeof field !== 'string' ||
        !['type', 'value', 'alias'].includes(field) ||
        !fieldDescriptor?.enumerable ||
        !('value' in fieldDescriptor)
      ) {
        throw new TokenBridgeError(
          'INVALID_TOKEN',
          'Token entry has unknown or non-data fields.',
          key,
        );
      }
    }
    if (
      typeof raw.type !== 'string' ||
      raw.type.length === 0 ||
      raw.type.length > limits.maxNameLength ||
      !Object.hasOwn(raw, 'value') ||
      (raw.alias !== undefined &&
        (typeof raw.alias !== 'string' ||
          raw.alias.length === 0 ||
          raw.alias.length > limits.maxNameLength))
    ) {
      throw new TokenBridgeError(
        'INVALID_TOKEN',
        'Token requires a type, value, and valid optional alias.',
        key,
      );
    }
    if (raw.alias !== undefined) {
      if (Object.hasOwn(raw, 'value') && raw.value !== null) {
        throw new TokenBridgeError(
          'INVALID_TOKEN',
          'Alias tokens must use null as their placeholder value.',
          key,
        );
      }
      entries.set(key, { type: raw.type, value: null, alias: raw.alias });
    } else {
      entries.set(key, {
        type: raw.type,
        value: copyJson(raw.value, limits, key),
      });
    }
  }
  return entries;
}

export function resolveTokenAliases(
  input: DesignTokenSet,
  inputLimits: TokenBridgeLimits = {},
): ResolvedTokenSet {
  const limits = limitsOf(inputLimits);
  const entries = tokenEntries(input, limits);
  const resolved = new Map<string, ResolvedToken>();
  const visit = (name: string): ResolvedToken => {
    const alreadyResolved = resolved.get(name);
    if (alreadyResolved) return alreadyResolved;
    const chain: string[] = [];
    const active = new Set<string>();
    let cursor = name;
    let target: ResolvedToken | undefined;
    while (target === undefined) {
      const cached = resolved.get(cursor);
      if (cached) {
        target = cached;
        break;
      }
      const token = entries.get(cursor);
      if (!token) {
        throw new TokenBridgeError(
          'ALIAS_MISSING',
          `Alias target "${cursor}" does not exist.`,
          cursor,
        );
      }
      if (active.has(cursor)) {
        throw new TokenBridgeError('ALIAS_CYCLE', 'Token aliases contain a cycle.', cursor);
      }
      active.add(cursor);
      chain.push(cursor);
      if (token.alias === undefined) {
        target = { type: token.type, value: token.value };
        break;
      }
      cursor = token.alias;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const chainName = chain[index]!;
      const token = entries.get(chainName)!;
      if (token.alias !== undefined && target!.type !== token.type) {
        throw new TokenBridgeError(
          'INVALID_TOKEN',
          'Alias type must match its target type.',
          chainName,
        );
      }
      target = { type: token.type, value: target!.value };
      resolved.set(chainName, target);
    }
    return resolved.get(name)!;
  };
  const output: Record<string, ResolvedToken> = {};
  for (const name of entries.keys()) {
    Object.defineProperty(output, name, {
      value: visit(name),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return output;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
    );
  }
  return false;
}

export function mapDesignTokens(
  input: DesignTokenSet,
  options: TokenMapOptions = {},
): {
  readonly tokens: ResolvedTokenSet;
  readonly diagnostics: readonly TokenChange[];
} {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TokenBridgeError('INVALID_TOKEN', 'Mapping options must be a plain record.');
  }
  const optionKeys = new Set(['nameMap', 'typeMap', 'transforms', 'limits']);
  for (const key of Reflect.ownKeys(options)) {
    const descriptor =
      typeof key === 'string' ? Object.getOwnPropertyDescriptor(options, key) : undefined;
    if (
      !descriptor ||
      !optionKeys.has(key as string) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new TokenBridgeError('INVALID_TOKEN', 'Mapping options contain unknown fields.');
    }
  }
  const validateMap = (value: unknown, label: string, expected: 'string' | 'function'): void => {
    if (value === undefined) return;
    if (!isRecord(value)) {
      throw new TokenBridgeError('INVALID_TOKEN', `${label} must be a plain record.`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor =
        typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        typeof descriptor.value !== expected
      ) {
        throw new TokenBridgeError('INVALID_TOKEN', `${label} contains an invalid entry.`);
      }
    }
  };
  validateMap(options.nameMap, 'nameMap', 'string');
  validateMap(options.typeMap, 'typeMap', 'string');
  validateMap(options.transforms, 'transforms', 'function');
  const limits = limitsOf(options.limits);
  const source = resolveTokenAliases(input, limits);
  const output: Record<string, ResolvedToken> = {};
  const diagnostics: TokenChange[] = [];
  for (const [sourceName, token] of Object.entries(source)) {
    const mappedName = options.nameMap
      ? Object.getOwnPropertyDescriptor(options.nameMap, sourceName)
      : undefined;
    const targetName = mappedName && 'value' in mappedName ? mappedName.value : sourceName;
    if (
      typeof targetName !== 'string' ||
      targetName.length === 0 ||
      targetName.length > limits.maxNameLength ||
      forbidden.has(targetName)
    ) {
      throw new TokenBridgeError('INVALID_TOKEN', 'Mapped token name is invalid.', sourceName);
    }
    if (Object.hasOwn(output, targetName)) {
      throw new TokenBridgeError(
        'NAME_COLLISION',
        `Multiple source tokens map to "${targetName}".`,
        targetName,
      );
    }
    const mappedType = options.typeMap
      ? Object.getOwnPropertyDescriptor(options.typeMap, token.type)
      : undefined;
    const targetType = mappedType && 'value' in mappedType ? mappedType.value : token.type;
    if (targetType.length === 0 || targetType.length > limits.maxNameLength) {
      throw new TokenBridgeError('INVALID_TOKEN', 'Mapped token type cannot be empty.', sourceName);
    }
    let mapped: ResolvedToken = {
      type: targetType,
      value: token.value,
    };
    const transformDescriptor = options.transforms
      ? Object.getOwnPropertyDescriptor(options.transforms, token.type)
      : undefined;
    const transform =
      transformDescriptor && 'value' in transformDescriptor ? transformDescriptor.value : undefined;
    if (transform !== undefined) {
      if (typeof transform !== 'function') {
        throw new TokenBridgeError(
          'INVALID_TRANSFORM',
          'Token transform must be a function.',
          sourceName,
        );
      }
      let converted: ResolvedToken;
      try {
        converted = transform(mapped);
      } catch {
        throw new TokenBridgeError('INVALID_TRANSFORM', 'Token transform failed.', sourceName);
      }
      if (!isRecord(converted)) {
        throw new TokenBridgeError(
          'INVALID_TRANSFORM',
          'Token transform must return a plain record.',
          sourceName,
        );
      }
      const convertedKeys = Reflect.ownKeys(converted);
      const typeDescriptor = Object.getOwnPropertyDescriptor(converted, 'type');
      const valueDescriptor = Object.getOwnPropertyDescriptor(converted, 'value');
      if (
        convertedKeys.length !== 2 ||
        convertedKeys.some((key) => key !== 'type' && key !== 'value') ||
        !typeDescriptor?.enumerable ||
        !('value' in typeDescriptor) ||
        !valueDescriptor?.enumerable ||
        !('value' in valueDescriptor) ||
        typeof typeDescriptor.value !== 'string' ||
        typeDescriptor.value.length === 0 ||
        typeDescriptor.value.length > limits.maxNameLength
      ) {
        throw new TokenBridgeError(
          'INVALID_TRANSFORM',
          'Token transform returned an invalid token.',
          sourceName,
        );
      }
      mapped = {
        type: typeDescriptor.value,
        value: copyJson(valueDescriptor.value, limits, sourceName),
      };
    }
    Object.defineProperty(output, targetName, {
      value: mapped,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    diagnostics.push({ kind: 'added', name: targetName });
  }
  return { tokens: output, diagnostics };
}

export function diffDesignTokens(
  before: ResolvedTokenSet,
  after: ResolvedTokenSet,
  inputLimits: TokenBridgeLimits = {},
): readonly TokenChange[] {
  const limits = limitsOf(inputLimits);
  const left = resolveTokenAliases(before, limits);
  const right = resolveTokenAliases(after, limits);
  const changes: TokenChange[] = [];
  for (const name of Object.keys(left)) {
    if (!Object.hasOwn(right, name)) {
      changes.push({ kind: 'removed', name });
      continue;
    }
    const fields: ('type' | 'value')[] = [];
    if (left[name]!.type !== right[name]!.type) fields.push('type');
    if (!sameValue(left[name]!.value, right[name]!.value)) fields.push('value');
    if (fields.length > 0) changes.push({ kind: 'changed', name, fields });
  }
  for (const name of Object.keys(right)) {
    if (!Object.hasOwn(left, name)) changes.push({ kind: 'added', name });
  }
  return changes;
}

export function parseHexColor(input: string): readonly [number, number, number, number] {
  if (typeof input !== 'string' || !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(input)) {
    throw new TypeError('Color must be a #RGB, #RGBA, #RRGGBB, or #RRGGBBAA hex value.');
  }
  const hex = input.slice(1);
  const expanded = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const values = expanded.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16));
  if (values.length === 3) values.push(255);
  return [values[0]!, values[1]!, values[2]!, values[3]!];
}

export function formatHexColor(
  color: readonly [number, number, number] | readonly [number, number, number, number],
): string {
  if (!Array.isArray(color) || (color.length !== 3 && color.length !== 4)) {
    throw new TypeError('Color must contain three RGB channels and optional alpha.');
  }
  const channels: number[] = [];
  for (let index = 0; index < color.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(color, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Color channels must be dense data values.');
    }
    const channel = descriptor.value;
    if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new RangeError('Color channels must be integers from 0 to 255.');
    }
    channels.push(channel);
  }
  for (const key of Reflect.ownKeys(color)) {
    if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) {
      throw new TypeError('Color channel arrays cannot have extra properties.');
    }
  }
  const text = channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
  return `#${text.toLowerCase()}`;
}

export interface SpacingConversion {
  readonly from: 'px' | 'rem';
  readonly to: 'px' | 'rem';
  readonly rootFontSize?: number;
}

export function convertSpacing(value: string, conversion: SpacingConversion): string;
export function convertSpacing(value: number, conversion: SpacingConversion): number;
export function convertSpacing(
  value: string | number,
  conversion: SpacingConversion,
): string | number {
  if (
    (conversion.from !== 'px' && conversion.from !== 'rem') ||
    (conversion.to !== 'px' && conversion.to !== 'rem')
  ) {
    throw new TypeError('Spacing units must be px or rem.');
  }
  const unitPattern =
    conversion.from === 'px' ? /^(-?(?:\d+\.?\d*|\.\d+))px$/ : /^(-?(?:\d+\.?\d*|\.\d+))rem$/;
  const match =
    typeof value === 'number'
      ? [String(value), String(value)]
      : typeof value === 'string'
        ? value.match(unitPattern)
        : null;
  if (!match)
    throw new TypeError(`Spacing value must be a finite number or a ${conversion.from} string.`);
  const number = Number(match[1]);
  if (!Number.isFinite(number)) throw new TypeError('Spacing value must be finite.');
  if (conversion.from === conversion.to) return value;
  const rootFontSize = conversion.rootFontSize ?? 16;
  if (!Number.isFinite(rootFontSize) || rootFontSize <= 0) {
    throw new RangeError('rootFontSize must be a positive finite number.');
  }
  const converted = conversion.from === 'px' ? number / rootFontSize : number * rootFontSize;
  if (!Number.isFinite(converted)) throw new RangeError('Converted spacing value is not finite.');
  return typeof value === 'number'
    ? converted
    : `${Number(converted.toPrecision(12))}${conversion.to}`;
}
