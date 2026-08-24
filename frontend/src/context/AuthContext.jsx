import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../api/endpoints.js';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('djs_token') || null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      const storedToken = localStorage.getItem('djs_token');
      if (storedToken) {
        try {
          const res = await api.auth.me();
          setUser(res.data.user);
        } catch (err) {
          localStorage.removeItem('djs_token');
          setToken(null);
          setUser(null);
        }
      }
      setLoading(false);
    };

    initAuth();
  }, []);

  const login = async (email, password) => {
    const res = await api.auth.login({ email, password });
    const { token: newToken, user: newUser } = res.data;
    localStorage.setItem('djs_token', newToken);
    setToken(newToken);
    setUser(newUser);
    return newUser;
  };

  const register = async (data) => {
    const res = await api.auth.register(data);
    const { token: newToken, user: newUser } = res.data;
    localStorage.setItem('djs_token', newToken);
    setToken(newToken);
    setUser(newUser);
    return newUser;
  };

  const logout = () => {
    localStorage.removeItem('djs_token');
    localStorage.removeItem('djs_api_key');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

