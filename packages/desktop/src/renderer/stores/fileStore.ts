import { create } from 'zustand';
import type { Artifact } from '@clawwork/shared';
import type { ArtifactKindFilter } from '@/lib/artifact-labels';

export interface ArtifactSearchResult {
  id: string;
  taskId: string;
  name: string;
  type: Artifact['type'];
  localPath: string;
  mimeType: string;
  size: number;
  createdAt: string;
  filePath: string;
  messageId: string;
  contentSnippet?: string;
}

interface FileState {
  artifacts: Artifact[];
  selectedArtifactId: string | null;
  searchQuery: string;
  searchResults: ArtifactSearchResult[] | null;
  isSearching: boolean;
  typeFilter: ArtifactKindFilter;

  setArtifacts: (artifacts: Artifact[]) => void;
  addArtifact: (artifact: Artifact) => void;
  upsertArtifact: (artifact: Artifact) => void;
  setSelectedArtifact: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: ArtifactSearchResult[] | null) => void;
  setIsSearching: (v: boolean) => void;
  setTypeFilter: (filter: ArtifactKindFilter) => void;
}

export const useFileStore = create<FileState>((set) => ({
  artifacts: [],
  selectedArtifactId: null,
  searchQuery: '',
  searchResults: null,
  isSearching: false,
  typeFilter: 'all',

  setArtifacts: (artifacts) => set({ artifacts }),

  addArtifact: (artifact) => set((s) => ({ artifacts: [artifact, ...s.artifacts] })),

  upsertArtifact: (artifact) =>
    set((s) => {
      const index = s.artifacts.findIndex((entry) => entry.id === artifact.id);
      if (index < 0) return { artifacts: [artifact, ...s.artifacts] };
      const existing = s.artifacts[index]!;
      const definedFields = Object.fromEntries(Object.entries(artifact).filter(([, value]) => value !== undefined));
      const merged = { ...existing, ...definedFields } as Artifact;
      if (Object.entries(merged).every(([key, value]) => Object.is(existing[key as keyof Artifact], value))) return s;
      const artifacts = [...s.artifacts];
      artifacts[index] = merged;
      return { artifacts };
    }),

  setSelectedArtifact: (id) => set({ selectedArtifactId: id }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchResults: (results) => set({ searchResults: results }),

  setIsSearching: (v) => set({ isSearching: v }),

  setTypeFilter: (filter) => set({ typeFilter: filter }),
}));
