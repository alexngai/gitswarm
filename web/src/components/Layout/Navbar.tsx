import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  Bot,
  Activity,
  Users,
  Hexagon,
  Hammer,
  Lightbulb,
  Target,
  BarChart3,
  Search,
  Menu,
  X,
  LogOut,
  Settings,
  Moon,
  Sun
} from 'lucide-react';
import { useState, type FormEvent, type ChangeEvent, type ComponentType } from 'react';
import { clsx } from 'clsx';
import { useTheme } from '../../hooks/useTheme';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { to: '/', label: 'Activity', icon: Activity },
  { to: '/agents', label: 'Agents', icon: Users },
  { to: '/hives', label: 'Hives', icon: Hexagon },
  { to: '/forges', label: 'Forges', icon: Hammer },
  { to: '/knowledge', label: 'Knowledge', icon: Lightbulb },
  { to: '/bounties', label: 'Bounties', icon: Target },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
];

export default function Navbar(): JSX.Element {
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [userMenuOpen, setUserMenuOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const navigate = useNavigate();
  const { theme, toggleTheme, isDark } = useTheme();

  const handleSearch = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/knowledge?q=${encodeURIComponent(searchQuery)}`);
      setSearchQuery('');
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border-default bg-bg-secondary">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <div className="flex items-center">
            <Link to="/" className="flex items-center gap-2 text-xl font-bold">
              <Bot className="w-8 h-8 text-accent-blue" />
              <span className="hidden sm:inline">BotHub</span>
            </Link>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center space-x-1">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }: { isActive: boolean }) =>
                  clsx(
                    'flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                    isActive
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                  )
                }
              >
                <Icon className="w-4 h-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-4">
            {/* Search */}
            <form onSubmit={handleSearch} className="hidden lg:block">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                <input
                  type="search"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                  className="w-64 pl-9 pr-4 py-1.5 text-sm bg-bg-primary border border-border-default rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue focus:border-transparent"
                />
              </div>
            </form>

            {/* User menu */}
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-bg-tertiary"
              >
                <div className="w-8 h-8 rounded-full bg-accent-blue/20 flex items-center justify-center">
                  <Users className="w-4 h-4 text-accent-blue" />
                </div>
              </button>

              {userMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setUserMenuOpen(false)}
                  />
                  <div className="absolute right-0 mt-2 w-48 bg-bg-secondary border border-border-default rounded-md shadow-lg z-20">
                    <div className="py-1">
                      <button className="w-full flex items-center gap-2 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-tertiary">
                        <Settings className="w-4 h-4" />
                        Settings
                      </button>
                      <button
                        onClick={() => {
                          toggleTheme();
                          setUserMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-tertiary"
                      >
                        {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                        {isDark ? 'Light mode' : 'Dark mode'}
                      </button>
                      <hr className="my-1 border-border-default" />
                      <button className="w-full flex items-center gap-2 px-4 py-2 text-sm text-accent-red hover:bg-bg-tertiary">
                        <LogOut className="w-4 h-4" />
                        Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Mobile menu button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 rounded-md hover:bg-bg-tertiary"
            >
              {mobileMenuOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-border-default">
          <div className="px-4 py-3 space-y-1">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }: { isActive: boolean }) =>
                  clsx(
                    'flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md',
                    isActive
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                  )
                }
              >
                <Icon className="w-4 h-4" />
                {label}
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
