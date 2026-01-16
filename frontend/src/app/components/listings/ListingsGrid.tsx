'use client';

import { useEffect, useState } from 'react';
import ListingCard from '../listings/ListingCard';
import ListingCardSkeleton from '../listings/ListingCardSkeleton';
import { Button } from '../ui/button';
import { listingService } from '../listings/listingService';
import { Listing } from '@/types/listing';

export default function ListingsGrid() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadListings();
  }, []);

  const loadListings = async () => {
    try {
      setLoading(true);
      const { data } = await listingService.getListings({ limit: 12 });
      setListings(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load listings');
    } finally {
      setLoading(false);
    }
  };

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <p className="text-red-600">{error}</p>
        <Button onClick={loadListings} className="mt-4">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-4">
      <div className="mb-4">
        <p className="text-sm text-gray-600">
          <span className="font-semibold">{listings.length}</span> venues available
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-6">
        {loading
          ? Array.from({ length: 8 }).map((_, i) => <ListingCardSkeleton key={i} />)
          : listings.map((listing) => (
              <ListingCard
                key={listing.id}
                id={listing.id}
                title={listing.title}
                location={listing.location}
                price={parseFloat(listing.basePrice)}
                capacity={listing.capacity}
                rating={listing.rating}
                image={listing.coverPhoto || ''}
                category={listing.category}
              />
            ))}
      </div>

      {!loading && (
        <div className="text-center">
          <Button variant="outline" size="lg">
            Load More
          </Button>
        </div>
      )}
    </div>
  );
}