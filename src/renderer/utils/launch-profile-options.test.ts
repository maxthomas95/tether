import { describe, expect, it } from 'vitest';
import { buildLaunchProfileOptions } from './launch-profile-options';

describe('buildLaunchProfileOptions', () => {
  it('sends an emptied flag list and env as empty values, not undefined', () => {
    expect(buildLaunchProfileOptions(' API Mode ', {}, { claude: [] })).toEqual({
      name: 'API Mode', envVars: {}, cliFlagsPerTool: {}, cliFlags: [],
    });
  });

  it('keeps non-empty flags per tool and mirrors claude flags into the legacy field', () => {
    expect(buildLaunchProfileOptions('p', { REGION: 'east' }, { claude: ['--verbose', ''], codex: [] })).toEqual({
      name: 'p', envVars: { REGION: 'east' }, cliFlagsPerTool: { claude: ['--verbose'] }, cliFlags: ['--verbose'],
    });
  });
});
