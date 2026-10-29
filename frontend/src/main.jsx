import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import CreateInvoicePage from './pages/CreateInvoicePage.jsx';
import InvoiceDetailPage from './pages/InvoiceDetailPage.jsx';
import InvoiceListPage from './pages/InvoiceListPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/invoices" element={<InvoiceListPage />} />
            <Route path="/invoices/new" element={<CreateInvoicePage />} />
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/invoices" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
