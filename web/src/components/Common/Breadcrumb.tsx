import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface BreadcrumbProps {
  items?: BreadcrumbItem[];
  showHome?: boolean;
  className?: string;
}

/**
 * Breadcrumb navigation component
 *
 * @example
 * <Breadcrumb items={[
 *   { label: 'Forges', to: '/forges' },
 *   { label: 'universal-api-client', to: '/forges/1' },
 *   { label: 'Patch #123' }
 * ]} />
 */
export default function Breadcrumb({ items = [], showHome = true, className = '' }: BreadcrumbProps): JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <nav className={`flex items-center text-sm ${className}`} aria-label="Breadcrumb">
      <ol className="flex items-center gap-1.5 flex-wrap">
        {showHome && (
          <li className="flex items-center gap-1.5">
            <Link
              to="/"
              className="text-text-muted hover:text-accent-blue transition-colors"
              aria-label="Home"
            >
              <Home className="w-4 h-4" />
            </Link>
            {items.length > 0 && (
              <ChevronRight className="w-4 h-4 text-text-muted" aria-hidden="true" />
            )}
          </li>
        )}

        {items.map((item, index) => {
          const isLast = index === items.length - 1;

          return (
            <li key={index} className="flex items-center gap-1.5">
              {item.to && !isLast ? (
                <Link
                  to={item.to}
                  className="text-text-muted hover:text-accent-blue transition-colors"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={isLast ? 'text-text-secondary font-medium' : 'text-text-muted'}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}

              {!isLast && (
                <ChevronRight className="w-4 h-4 text-text-muted" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
