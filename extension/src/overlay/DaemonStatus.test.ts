import { describe, expect, test } from 'vitest';
import { daemonStatusCopy } from './DaemonStatus';

describe('daemon status copy', () => {
  test('describes the live scanner lifecycle', () => {
    expect(daemonStatusCopy('checking', 'block').title).toBe('Checking local scanner');
    expect(daemonStatusCopy('online', 'block').detail).toContain('active');
    expect(daemonStatusCopy('scanning', 'block').detail).toContain('not been released');
    expect(daemonStatusCopy('restored', 'block').title).toBe('Local scanner restored');
  });

  test('does not misrepresent the configured failure policy while offline', () => {
    expect(daemonStatusCopy('offline', 'block').detail).toContain('blocked');
    expect(daemonStatusCopy('offline', 'allow').detail).toContain('permits');
  });
});
