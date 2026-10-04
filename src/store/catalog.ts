import apparel from '@/assets/apparel.jpg';
import book from '@/assets/book.jpg';
import print from '@/assets/print.jpg';
import hoodie from '@/assets/hoodie.jpg';
import journal from '@/assets/journal.jpg';
import poster from '@/assets/poster.jpg';
import ikenga from '@/assets/ikenga.jpg';
import bronzeHead from '@/assets/bronze-head.jpg';
import woodFigure from '@/assets/wood-figure.jpg';

export type Product = { slug: string; title: string; category: string; price: number; image: string; description: string; details: string[]; variants?: string[]; status?: string; };
export const products: Product[] = [
  { slug: 'ozikoro-heritage-tee', title: 'Ozikoro Heritage Tee', category: 'Apparel', price: 18500, image: apparel, description: 'A considered everyday essential, made to carry culture forward. Cut from substantial cotton with a relaxed, comfortable fit.', details: ['100% heavyweight cotton', 'Relaxed unisex fit', 'Machine wash cold; wash inside out'], variants: ['S','M','L','XL'] },
  { slug: 'the-ozikoro-reader', title: 'The Ozikoro Reader', category: 'Books & Publications', price: 24000, image: book, description: 'A collection of essays and perspectives exploring language, history and cultural knowledge.', details: ['Hardcover · 224 pages', 'Edited by Ozikoro', 'First edition · English'], variants: ['Hardcover'] },
  { slug: 'land-and-memory-print', title: 'Land & Memory Print', category: 'Prints & Posters', price: 16000, image: print, description: 'An archival-inspired study of place and memory, printed on richly textured paper.', details: ['Archival pigment print', 'A2 · 42 × 59.4 cm', 'Unframed; ships carefully rolled'], variants: ['A2','A3'] },
  { slug: 'everyday-hoodie', title: 'Everyday Hoodie', category: 'Apparel', price: 34000, image: hoodie, description: 'An easy layer with a quietly expressive detail. Designed for comfort and made to last.', details: ['Heavyweight cotton blend', 'Relaxed unisex fit', 'Machine wash cold'], variants: ['S','M','L','XL'] },
  { slug: 'notes-on-culture', title: 'Notes on Culture', category: 'Books & Publications', price: 19500, image: journal, description: 'A thoughtful collection of writing on the stories and ideas that shape us.', details: ['Softcover · 168 pages', 'Published by Ozikoro', 'English'], variants: ['Softcover'] },
  { slug: 'forms-of-belonging', title: 'Forms of Belonging', category: 'Prints & Posters', price: 14500, image: poster, description: 'A graphic exploration of identity and belonging, printed with care for the spaces we inhabit.', details: ['Archival pigment print', 'A2 · 42 × 59.4 cm', 'Unframed'], variants: ['A2','A3'] },
  { slug: 'ikenga-carved-figure', title: 'Ikenga Carved Figure', category: 'Art & Artefacts', price: 285000, image: ikenga, description: 'A hand-carved Ikenga figure with sweeping ram horns, honouring strength, achievement and the personal drive to move forward.', details: ['Hand-carved hardwood', 'Approx. 45 cm tall', 'Each piece is unique; carving details vary'] },
  { slug: 'bronze-heritage-head', title: 'Bronze Heritage Head', category: 'Art & Artefacts', price: 420000, image: bronzeHead, description: 'A cast bronze head inspired by classical West African metalwork traditions, finished with a warm aged patina.', details: ['Lost-wax cast bronze', 'Approx. 32 cm tall', 'Hand-finished patina'] },
  { slug: 'mother-and-child-sculpture', title: 'Mother & Child Sculpture', category: 'Art & Artefacts', price: 195000, image: woodFigure, description: 'A tender carved wood sculpture celebrating care, lineage and the bonds that carry families forward.', details: ['Hand-carved hardwood', 'Approx. 50 cm tall', 'Polished natural finish'] },
];
export const categories = [
  { slug: 'apparel', title: 'Apparel', description: 'Everyday pieces with a story to tell.', image: apparel },
  { slug: 'books-publications', title: 'Books & Publications', description: 'Ideas worth holding on to.', image: book },
  { slug: 'prints-posters', title: 'Prints & Posters', description: 'Art for spaces that mean something.', image: print },
  { slug: 'art-artefacts', title: 'Art & Artefacts', description: 'Ikenga, sculptures and carved works.', image: ikenga },
];
export const money = (value: number) => `₦${value.toLocaleString('en-NG')}`;
