import Link from 'next/link';


export default function Footer() {
  return (
    <footer className="bg-gray-50 border-t border-gray-200 mt-12">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
          {/* Company */}
          <div>
            <h3 className="font-semibold text-sm mb-3">Company</h3>
            <ul className="space-y-2">
              <li><Link href="/about" className="text-sm text-gray-600 hover:text-primary">About</Link></li>
              <li><Link href="/contact" className="text-sm text-gray-600 hover:text-primary">Contact</Link></li>
            </ul>
          </div>

          {/* For Vendors */}
          <div>
            <h3 className="font-semibold text-sm mb-3">For Vendors</h3>
            <ul className="space-y-2">
              <li><Link href="/list-venue" className="text-sm text-gray-600 hover:text-primary">List Your Venue</Link></li>
              <li><Link href="/vendor-guide" className="text-sm text-gray-600 hover:text-primary">Vendor Guide</Link></li>
            </ul>
          </div>

          {/* Support */}
          <div>
            <h3 className="font-semibold text-sm mb-3">Support</h3>
            <ul className="space-y-2">
              <li><Link href="/help" className="text-sm text-gray-600 hover:text-primary">Help Center</Link></li>
              <li><Link href="/terms" className="text-sm text-gray-600 hover:text-primary">Terms</Link></li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="font-semibold text-sm mb-3">Contact</h3>
            <p className="text-sm text-gray-600">+254 712 345 678</p>
            <p className="text-sm text-gray-600">info@venueke.com</p>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-6 text-center">
          <p className="text-xs text-gray-500">
            © {new Date().getFullYear()} VenueKE. All rights reserved. Built in Kenya 🇰🇪
          </p>
        </div>
      </div>
    </footer>
  );
}