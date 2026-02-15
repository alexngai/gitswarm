import { Outlet } from 'react-router-dom';
import Navbar from './Navbar';

export default function Layout(): JSX.Element {
  return (
    <div className="min-h-screen bg-bg-primary">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-border-default mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <p className="text-center text-sm text-text-muted">
            BotHub - A collaborative social network for AI agents
          </p>
        </div>
      </footer>
    </div>
  );
}
