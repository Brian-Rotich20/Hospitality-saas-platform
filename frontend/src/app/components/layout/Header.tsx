'use client';

import Link from 'next/link';
import { Search, MapPin, User, Menu } from 'lucide-react';
import { useState } from 'react';

export default function Header() {
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <header className="sticky top-0 z-50 bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 py-3">
        {/* Top Row */}
        <div className="flex items-center gap-3 mb-3">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <MapPin className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-bold text-primary hidden sm:block">
              Inova
            </span>
          </Link>

          {/* Search Bar */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          
            <input
              type="text"
              placeholder="Search venues, caterers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-all"
            />
          </div>

          {/* User Menu */}
          <Link href="/login">
            <button className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200">
              <User className="w-5 h-5 text-gray-700" />
            </button>
          </Link>
        </div>

        {/* Location & Filter Row */}
        <div className="flex items-center justify-between">
          <button className="flex items-center gap-1 text-sm font-medium text-gray-700 hover:text-primary">
            <MapPin className="w-4 h-4" />
            Nairobi, Kenya
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <button className="flex items-center gap-1 text-sm text-gray-700 hover:text-primary">
            <Menu className="w-4 h-4" />
            Filters
          </button>
        </div>
      </div>
    </header>
  );
}