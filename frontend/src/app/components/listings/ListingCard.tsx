import Image from 'next/image';
import Link from 'next/link';
import { MapPin, Users, Star, Heart } from 'lucide-react';

interface ListingCardProps {
  id: string;
  title: string;
  location: string;
  price: number;
  capacity?: number;
  rating?: number;
  image: string;
  category: string;
}

export default function ListingCard({
  id,
  title,
  location,
  price,
  capacity,
  rating,
  image,
  category,
}: ListingCardProps) {
  return (
    <Link href={`/listings/${id}`}>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-xl hover:border-gray-300 transition-all duration-300">
        {/* Image */}
        <div className="relative h-48 bg-gray-200">
          {/* Placeholder gradient */}
          <div className="absolute inset-0 bg-linear-to-br from-primary-300 via-primary-200 to-accent-lighter"></div>
          
          {/* Favorite Button */}
          <button 
            className="absolute top-3 right-3 w-9 h-9 bg-white rounded-full flex items-center justify-center shadow-lg hover:scale-110 transition-transform z-10"
            onClick={(e) => e.preventDefault()}
          >
            <Heart className="w-4 h-4 text-gray-600 hover:text-red-500 transition-colors" />
          </button>

          {/* Category Badge */}
          <div className="absolute bottom-3 left-3">
            <span className="px-3 py-1.5 bg-white/95 backdrop-blur-sm rounded-full text-xs font-medium text-gray-700 shadow-sm">
              {category}
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="p-4">
          {/* Title */}
          <h3 className="font-semibold text-base text-gray-900 mb-2 line-clamp-1">
            {title}
          </h3>

          {/* Location */}
          <div className="flex items-center gap-1.5 text-sm text-gray-600 mb-3">
            <MapPin className="w-4 h-4 text-gray-400" />
            <span className="line-clamp-1">{location}</span>
          </div>

          {/* Bottom Row */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <div>
              <p className="text-lg font-bold text-gray-900">
                KES {price.toLocaleString()}
              </p>
              <p className="text-xs text-gray-500">per day</p>
            </div>

            {/* Rating & Capacity */}
            <div className="flex flex-col items-end gap-1.5">
              {rating && (
                <div className="flex items-center gap-1">
                  <Star className="w-4 h-4 text-accent fill-accent" />
                  <span className="text-sm font-semibold text-gray-900">{rating}</span>
                </div>
              )}
              {capacity && (
                <div className="flex items-center gap-1 text-xs text-gray-600">
                  <Users className="w-3.5 h-3.5" />
                  <span>{capacity}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}