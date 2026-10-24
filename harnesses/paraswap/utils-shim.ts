// HARNESS SHIM: the real src/utils.ts pulls in web3/axios/lodash etc.
// The two functions below are copied VERBATIM from paraswap-dex-lib@291393f0 src/utils.ts:76-101.
export function stringifyWithBigInt(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value), // return everything else unchanged
  );
}

export function _require(
  b: boolean,
  message: string,
  values?: Record<string, unknown>,
  condition?: string,
): void {
  if (!b) {
    let receivedValues = '';
    if (values && condition) {
      const keyValueStr = Object.entries(values)
        .map(([k, v]) => `${k}=${stringifyWithBigInt(v)}`)
        .join(', ');
      receivedValues = `Values: ${keyValueStr}. Condition: ${condition} violated. `;
    }
    throw new Error(
      `${receivedValues}Error message: ${message ? message : 'undefined'}`,
    );
  }
}
