/**
 * The search box.
 *
 * Submits as a real GET navigation to `/search?q=…`, so the results are a
 * server-rendered, shareable, crawlable URL rather than something that only
 * exists in one browser's memory.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Search as SearchIcon } from 'lucide-react';

export function SearchForm({ initialQuery = '' }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const navigate = useNavigate();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // `replace` on an empty query would lose the page the visitor came from;
    // push is correct for every case here.
    void navigate({ to: '/search', search: { q: query.trim() } });
  }

  return (
    <form onSubmit={onSubmit} role="search" className="flex items-center border-b border-foreground pb-3 gap-4">
      <SearchIcon size={22} aria-hidden />
      <label className="sr-only" htmlFor="store-search">
        Search products
      </label>
      <input
        id="store-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search products, collections..."
        className="bg-transparent outline-none flex-1 text-lg md:text-2xl placeholder:text-muted-foreground"
        data-testid="search-input"
      />
      <button type="submit" className="text-sm underline" data-testid="search-submit">
        Search
      </button>
    </form>
  );
}
