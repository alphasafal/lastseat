import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post } from './api.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking

  useEffect(() => {
    get('/api/auth/session')
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, []);

  const signIn = useCallback(async (path, body) => {
    const data = await post(path, body);
    setUser(data.user);
    return data.user;
  }, []);

  const value = useMemo(
    () => ({
      user,
      login: (body) => signIn('/api/auth/login', body),
      register: (body) => signIn('/api/auth/register', body),
      demo: () => signIn('/api/auth/demo', {}),
      async logout() {
        await post('/api/auth/logout', {});
        setUser(null);
      },
    }),
    [user, signIn],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
