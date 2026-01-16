'use client';

import { Building2, Utensils, Hotel } from 'lucide-react';
import { useState } from 'react';

const categories = [
  { id: 'all', label: 'All', icon: null },
  { id: 'event_venue', label: 'Venues', icon: Building2 },
  { id: 'catering', label: 'Catering', icon: Utensils },
  { id: 'accommodation', label: 'Stays', icon: Hotel },
  { id: 'decor', label: 'Decor', icon: null },
  { id: 'entertainment', label: 'Entertainment', icon: null },  
  { id: 'transportation', label: 'Transportation', icon: null },
];

export default function CategoryPills() {
  const [selected, setSelected] = useState('all');

  return (
    <div className="px-4 py-3 border-b border-gray-100 bg-white z-0">
      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {categories.map((category) => {
          const Icon = category.icon;
          const isSelected = selected === category.id;

          return (
            <button
              key={category.id}
              onClick={() => setSelected(category.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full whitespace-nowrap transition-colors ${
                isSelected
                  ? 'bg-primary text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {Icon && <Icon className="w-4 h-4" />}
              <span className="text-sm font-medium">{category.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}