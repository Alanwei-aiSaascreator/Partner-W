import { createStore } from 'zustand/vanilla';
import type { TeamMeetingRecord } from '@clawwork/shared';

export interface TeamMeetingState {
  records: TeamMeetingRecord[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  errors: Record<string, string>;
}

export const initialMeetingState = (): TeamMeetingState => ({
  records: [],
  loading: false,
  loaded: false,
  error: null,
  errors: {},
});
export const createTeamMeetingStore = () => createStore<TeamMeetingState>()(() => initialMeetingState());
