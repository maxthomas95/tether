import { describe, expect, it } from 'vitest';
import { mergeRecentProjects, parseRecentProjects } from './recent-projects';

describe('recent project locations', () => {
  it('recovers from corrupt or obsolete saved preferences', () => {
    for (const value of [null, 'not json', '{}', '[null,42,{}, {"workingDir":""}]']) {
      expect(parseRecentProjects(value)).toEqual([]);
    }
  });

  it('only retains location metadata and bounds the list', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ workingDir: `/project/${i}`, environmentId: 'local', env: { TOKEN: 'private' } }));
    const result = parseRecentProjects(JSON.stringify(rows));
    expect(result).toHaveLength(6);
    expect(result[0]).toEqual({ workingDir: '/project/0', environmentId: 'local' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('promotes a revisited directory and distinguishes machines', () => {
    const first = { workingDir: '/work/tether', environmentId: 'local' };
    const remote = { ...first, environmentId: 'ssh' };
    const second = { workingDir: '/work/second', environmentId: 'local' };
    expect(mergeRecentProjects([second, first], [first, remote])).toEqual([first, remote, second]);
  });
});
