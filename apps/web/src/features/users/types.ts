export interface UserRow {
  id: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  createdAt: string;
  updatedAt: string;
}
