import { getPrefixForCity, AU_CITY_PREFIXES, InvalidCityError } from './au-city-prefixes';

describe('au-city-prefixes', () => {
  it('should return correct prefix for every code in the table', () => {
    for (const city of AU_CITY_PREFIXES) {
      expect(getPrefixForCity(city.code)).toBe(city.prefix);
    }
  });

  it('should throw InvalidCityError for unknown code', () => {
    expect(() => getPrefixForCity('unknown-city')).toThrow(InvalidCityError);
  });
});
