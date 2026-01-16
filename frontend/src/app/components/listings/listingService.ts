import api from '@/lib/api';
import { Listing, ListingFilters } from '@/types/listing';
import { mockListings } from '@/lib/mockData';

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === 'true';

export const listingService = {
  async getListings(filters?: ListingFilters): Promise<{ data: Listing[]; count: number }> {
    if (USE_MOCK) {
      await new Promise(resolve => setTimeout(resolve, 800)); // Simulate network delay
      return { data: mockListings, count: mockListings.length };
    }

    const params = new URLSearchParams();
    if (filters?.category) params.append('category', filters.category);
    if (filters?.location) params.append('location', filters.location);
    if (filters?.search) params.append('search', filters.search);
    if (filters?.limit) params.append('limit', filters.limit.toString());
    if (filters?.offset) params.append('offset', filters.offset.toString());

    return api.get(`/api/listings?${params.toString()}`);
  },

  async getListingById(id: string): Promise<Listing> {
    if (USE_MOCK) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const listing = mockListings.find(l => l.id === id);
      if (!listing) throw new Error('Listing not found');
      return listing;
    }

    return api.get(`/api/listings/${id}`);
  },
};