import { describe, it, expect } from 'vitest';
import { extractSelectedPair, classifyPath } from './candidate';

function makeReport(
  stats: Array<RTCStats & Record<string, unknown>>,
): RTCStatsReport {
  return new Map(stats.map((s) => [s.id, s])) as unknown as RTCStatsReport;
}

describe('extractSelectedPair', () => {
  it('transport.selectedCandidatePairId を最優先で辿る', () => {
    const report = makeReport([
      { id: 't', type: 'transport', selectedCandidatePairId: 'pair1' } as never,
      {
        id: 'pair1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'lc',
        remoteCandidateId: 'rc',
        currentRoundTripTime: 0.123,
        availableOutgoingBitrate: 2_000_000,
      } as never,
      {
        id: 'lc',
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'udp',
        relayProtocol: 'tls',
        url: 'turns:abc.livekit.cloud:443?transport=tcp',
        address: '1.2.3.4',
        port: 50000,
      } as never,
      { id: 'rc', type: 'remote-candidate', candidateType: 'relay', address: '5.6.7.8' } as never,
    ]);
    const pair = extractSelectedPair(report);
    expect(pair?.local.candidateType).toBe('relay');
    expect(pair?.local.relayProtocol).toBe('tls');
    expect(pair?.local.url).toContain(':443');
    expect(pair?.currentRoundTripTimeMs).toBeCloseTo(123, 0);
    expect(pair?.availableOutgoingBitrateKbps).toBeCloseTo(2000, 0);
  });

  it('transport が無ければ nominated+succeeded を選ぶ', () => {
    const report = makeReport([
      { id: 'p0', type: 'candidate-pair', state: 'failed', localCandidateId: 'l0' } as never,
      {
        id: 'p1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'l1',
      } as never,
      { id: 'l1', type: 'local-candidate', candidateType: 'srflx' } as never,
    ]);
    expect(extractSelectedPair(report)?.local.candidateType).toBe('srflx');
  });

  it('selected pair が無ければ null', () => {
    expect(extractSelectedPair(makeReport([]))).toBeNull();
  });
});

describe('classifyPath', () => {
  const pairWith = (local: Record<string, unknown>) => ({
    local: local as never,
    remote: {},
  });

  it('relay + relayProtocol=tls → relay-tls / isTurnTls / is443', () => {
    const v = classifyPath(
      pairWith({
        candidateType: 'relay',
        relayProtocol: 'tls',
        url: 'turns:x.livekit.cloud:443?transport=tcp',
      }),
    );
    expect(v.kind).toBe('relay-tls');
    expect(v.isTurnTls).toBe(true);
    expect(v.isRelay).toBe(true);
    expect(v.is443).toBe(true);
  });

  it('relay + relayProtocol=udp → relay-udp', () => {
    const v = classifyPath(pairWith({ candidateType: 'relay', relayProtocol: 'udp' }));
    expect(v.kind).toBe('relay-udp');
    expect(v.isTurnTls).toBe(false);
  });

  it('srflx → srflx（P2P/UDP直）', () => {
    expect(classifyPath(pairWith({ candidateType: 'srflx' })).kind).toBe('srflx');
  });

  it('host → host', () => {
    expect(classifyPath(pairWith({ candidateType: 'host' })).kind).toBe('host');
  });

  it('port=443 だけでも is443 を立てる', () => {
    const v = classifyPath(pairWith({ candidateType: 'relay', relayProtocol: 'tcp', port: 443 }));
    expect(v.is443).toBe(true);
    expect(v.kind).toBe('relay-tcp');
  });

  it('null は unknown', () => {
    expect(classifyPath(null).kind).toBe('unknown');
  });
});
