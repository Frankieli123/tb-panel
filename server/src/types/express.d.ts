type SystemUserRole = 'admin' | 'operator';

declare global {
  namespace Express {
    interface Request {
      systemAuth?:
        | { kind: 'apiKey' }
        | {
            kind: 'session';
            sessionId: string;
            token: string;
            csrfToken: string;
            user: { id: string; username: string; role: SystemUserRole };
          };
    }
  }
}

export {};
