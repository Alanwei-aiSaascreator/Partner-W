import { describe, expect, it } from 'vitest';
import { deriveModelAvailability } from '../src/renderer/components/ChatInput/model-availability.js';

describe('deriveModelAvailability', () => {
  it('reports service startup before the gateway connects', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connecting',
        rawCatalog: undefined,
        modelCount: 0,
      }),
    ).toBe('service-starting');
  });

  it('reports model preparation while a connected gateway is still fetching its catalog', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: undefined,
        modelCount: 0,
      }),
    ).toBe('models-loading');
  });

  it('reports empty only after the catalog has resolved without commercial models', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: [],
        modelCount: 0,
      }),
    ).toBe('empty');
  });

  it('reports ready when a commercial model is available', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: [{} as never],
        modelCount: 1,
      }),
    ).toBe('ready');
  });
});
