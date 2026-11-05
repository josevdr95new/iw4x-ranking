import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { AuthProvider } from "./lib/auth";
import { AuthPage } from "./pages/AuthPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { LinkPage } from "./pages/LinkPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PlayerPage } from "./pages/PlayerPage";

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <div className="flex min-h-screen flex-col">
          <a
            href="#contenido"
            className="type-label sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[70] focus:-translate-y-0 focus:rounded-sm focus:bg-accent focus:px-4 focus:py-2 focus:text-on-accent"
          >
            Saltar al contenido
          </a>
          <Navbar />
          <main id="contenido" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-6">
            <Routes>
              <Route path="/" element={<LeaderboardPage />} />
              <Route path="/player/:guid" element={<PlayerPage />} />
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/register" element={<AuthPage mode="register" />} />
              <Route path="/link" element={<LinkPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </main>
        </div>
      </AuthProvider>
    </BrowserRouter>
  );
}
