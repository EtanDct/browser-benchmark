export interface NavigationResult {
  success: boolean;
  httpStatus?: number;
  loadTimeMs: number;
  antiBotPassed?: boolean;
  domSnapshotHash?: string;
  errorMessage?: string;
}

export interface BrowserAdapter {
  /** ex: "puppeteer-chromium" */
  name: string;
  /** demarre le navigateur, retourne le PID racine pour le monitoring */
  launch(): Promise<{ pid: number }>;
  navigate(url: string): Promise<NavigationResult>;
  close(): Promise<void>;
}
