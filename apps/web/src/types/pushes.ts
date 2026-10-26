export interface Push {
  id: string;
  favicon: string;
  createdAt: Date;
  searchTokens: string[];
  title: string;
  type: string;
  url: string;
  userId: string;
  ext?: string;
}

export type PushData = Omit<Push, 'id' | 'favicon'>;
