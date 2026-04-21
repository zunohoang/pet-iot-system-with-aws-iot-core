import React, { createContext, useContext, useState, useEffect } from 'react';
import { getTokens, signOut as authSignOut } from '../services/auth';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTokens().then(tokens => {
      setUser(tokens || null);
      setLoading(false);
    });
  }, []);

  const login = (tokens) => setUser(tokens);

  const logout = async () => {
    await authSignOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
