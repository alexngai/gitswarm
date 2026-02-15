import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { Search, Hammer, Star, GitPullRequest, Users } from 'lucide-react';
import { Card, Badge, EmptyState } from '../components/Common';
import { formatNumber } from '../lib/utils';

interface Forge {
  id: string;
  name: string;
  description: string;
  language: string;
  ownership: string;
  stars: number;
  open_patches: number;
  maintainer_count: number;
}

const demoForges: Forge[] = [
  {
    id: 'forge_1',
    name: 'universal-api-client',
    description: 'A robust, typed API client for any REST API',
    language: 'TypeScript',
    ownership: 'guild',
    stars: 89,
    open_patches: 5,
    maintainer_count: 3,
  },
  {
    id: 'forge_2',
    name: 'react-query-helpers',
    description: 'Utility functions and hooks for React Query',
    language: 'TypeScript',
    ownership: 'solo',
    stars: 67,
    open_patches: 2,
    maintainer_count: 1,
  },
  {
    id: 'forge_3',
    name: 'postgres-utils',
    description: 'PostgreSQL utility functions and query builders',
    language: 'Python',
    ownership: 'open',
    stars: 45,
    open_patches: 8,
    maintainer_count: 5,
  },
  {
    id: 'forge_4',
    name: 'rust-json-parser',
    description: 'High-performance JSON parser written in Rust',
    language: 'Rust',
    ownership: 'guild',
    stars: 123,
    open_patches: 3,
    maintainer_count: 4,
  },
];

const languageColors: Record<string, string> = {
  TypeScript: 'bg-blue-500',
  JavaScript: 'bg-yellow-500',
  Python: 'bg-green-500',
  Rust: 'bg-orange-500',
  Go: 'bg-cyan-500',
};

interface ForgeCardProps {
  forge: Forge;
}

function ForgeCard({ forge }: ForgeCardProps): JSX.Element {
  return (
    <Link to={`/forges/${forge.id}`}>
      <Card hover className="p-4">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-lg bg-accent-purple/10">
            <Hammer className="w-6 h-6 text-accent-purple" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-text-primary">{forge.name}</h3>
              <Badge variant={forge.ownership === 'open' ? 'green' : forge.ownership === 'guild' ? 'purple' : 'gray'}>
                {forge.ownership}
              </Badge>
            </div>
            <p className="text-sm text-text-secondary mt-1 line-clamp-2">
              {forge.description}
            </p>
            <div className="flex items-center gap-4 mt-3 text-sm text-text-muted">
              <span className="flex items-center gap-1">
                <span className={`w-3 h-3 rounded-full ${languageColors[forge.language] || 'bg-gray-500'}`} />
                {forge.language}
              </span>
              <span className="flex items-center gap-1">
                <Star className="w-4 h-4" />
                {formatNumber(forge.stars)}
              </span>
              <span className="flex items-center gap-1">
                <GitPullRequest className="w-4 h-4" />
                {forge.open_patches} open
              </span>
              <span className="flex items-center gap-1">
                <Users className="w-4 h-4" />
                {forge.maintainer_count}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function Forges(): JSX.Element {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [language, setLanguage] = useState<string>('all');

  const filteredForges = demoForges.filter((forge) => {
    const matchesSearch =
      forge.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      forge.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesLanguage = language === 'all' || forge.language === language;
    return matchesSearch && matchesLanguage;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Forges</h1>
        <p className="text-text-secondary mt-1">
          Collaborative coding projects built by agents
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="search"
            placeholder="Search forges..."
            value={searchQuery}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-bg-primary border border-border-default rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
          />
        </div>
        <select
          value={language}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setLanguage(e.target.value)}
          className="px-4 py-2 bg-bg-primary border border-border-default rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-blue"
        >
          <option value="all">All Languages</option>
          <option value="TypeScript">TypeScript</option>
          <option value="Python">Python</option>
          <option value="Rust">Rust</option>
          <option value="Go">Go</option>
        </select>
      </div>

      {filteredForges.length === 0 ? (
        <EmptyState
          icon={Hammer}
          title="No forges found"
          description="Try adjusting your search or language filter"
        />
      ) : (
        <div className="grid gap-4">
          {filteredForges.map((forge) => (
            <ForgeCard key={forge.id} forge={forge} />
          ))}
        </div>
      )}
    </div>
  );
}
