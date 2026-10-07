"""Read-time US location priority for the OneShot opportunity list.

This is UI policy, not posting enrichment.  Entries are normalized
``(state, city)`` pairs from ``job_posting.locations`` and are never persisted
back to a posting.
"""

from typing import Final


RECENCY_TIME_ZONE: Final = "America/Los_Angeles"

US_HUB_CITIES: Final = frozenset(
    {
        ("AZ", "Phoenix"),
        ("CA", "Los Angeles"),
        ("CA", "Oakland"),
        ("CA", "San Diego"),
        ("CA", "San Francisco"),
        ("CA", "San Jose"),
        ("CO", "Boulder"),
        ("CO", "Denver"),
        ("DC", "Washington"),
        ("FL", "Jacksonville"),
        ("FL", "Miami"),
        ("FL", "Tampa"),
        ("GA", "Atlanta"),
        ("IL", "Chicago"),
        ("MA", "Boston"),
        ("MA", "Cambridge"),
        ("MD", "Baltimore"),
        ("MI", "Ann Arbor"),
        ("MI", "Detroit"),
        ("MN", "Minneapolis"),
        ("MN", "Saint Paul"),
        ("MO", "Kansas City"),
        ("MO", "St. Louis"),
        ("NC", "Chapel Hill"),
        ("NC", "Charlotte"),
        ("NC", "Durham"),
        ("NC", "Raleigh"),
        ("NY", "New York City"),
        ("OH", "Columbus"),
        ("OR", "Portland"),
        ("PA", "Philadelphia"),
        ("PA", "Pittsburgh"),
        ("TN", "Nashville"),
        ("TX", "Austin"),
        ("TX", "Dallas"),
        ("TX", "Fort Worth"),
        ("TX", "Houston"),
        ("UT", "Salt Lake City"),
        ("WA", "Seattle"),
    }
)

US_SUBURB_CITIES: Final = frozenset(
    {
        # San Francisco Bay Area
        ("CA", "Alameda"), ("CA", "Berkeley"), ("CA", "Burlingame"),
        ("CA", "Daly City"), ("CA", "Emeryville"), ("CA", "Foster City"),
        ("CA", "Fremont"), ("CA", "Hayward"), ("CA", "Livermore"),
        ("CA", "Los Altos"), ("CA", "Menlo Park"), ("CA", "Milpitas"),
        ("CA", "Mountain View"), ("CA", "Palo Alto"), ("CA", "Redwood City"),
        ("CA", "Richmond"), ("CA", "San Carlos"), ("CA", "San Mateo"),
        ("CA", "Santa Clara"), ("CA", "South San Francisco"),
        ("CA", "Sunnyvale"), ("CA", "Union City"), ("CA", "Walnut Creek"),
        # New York metro
        ("CT", "Greenwich"), ("CT", "Norwalk"), ("CT", "Stamford"),
        ("NJ", "Bayonne"), ("NJ", "Bridgewater"), ("NJ", "East Orange"),
        ("NJ", "Edison"), ("NJ", "Elizabeth"), ("NJ", "Fort Lee"),
        ("NJ", "Jersey City"), ("NJ", "Newark"), ("NJ", "Paramus"),
        ("NJ", "Parsippany"), ("NJ", "Passaic"), ("NJ", "Paterson"),
        ("NJ", "Secaucus"), ("NJ", "Short Hills"),
        ("NY", "Brooklyn"), ("NY", "Hauppauge"), ("NY", "Long Beach"),
        ("NY", "Mineola"), ("NY", "Mount Vernon"), ("NY", "Nanuet"),
        ("NY", "New Rochelle"), ("NY", "Oceanside"),
        ("NY", "Port Washington"), ("NY", "White Plains"), ("NY", "Yonkers"),
        # Los Angeles and Orange County
        ("CA", "Anaheim"), ("CA", "Arcadia"), ("CA", "Beverly Hills"),
        ("CA", "Burbank"), ("CA", "Calabasas"), ("CA", "Costa Mesa"),
        ("CA", "Culver City"), ("CA", "El Segundo"), ("CA", "Glendale"),
        ("CA", "Hawthorne"), ("CA", "Huntington Beach"), ("CA", "Inglewood"),
        ("CA", "Irvine"), ("CA", "Long Beach"), ("CA", "Newport Beach"),
        ("CA", "Pasadena"), ("CA", "Santa Clarita"), ("CA", "Santa Monica"),
        ("CA", "Simi Valley"), ("CA", "Thousand Oaks"), ("CA", "Torrance"),
        ("CA", "West Hollywood"), ("CA", "Whittier"),
        # Seattle
        ("WA", "Bellevue"), ("WA", "Everett"), ("WA", "Federal Way"),
        ("WA", "Kent"), ("WA", "Kirkland"), ("WA", "Redmond"),
        ("WA", "Renton"), ("WA", "Sammamish"), ("WA", "Tacoma"),
        ("WA", "Tukwila"), ("WA", "Woodinville"),
        # Boston
        ("MA", "Andover"), ("MA", "Brookline"), ("MA", "Burlington"),
        ("MA", "Dedham"), ("MA", "Lynn"), ("MA", "Marlborough"),
        ("MA", "Maynard"), ("MA", "Quincy"), ("MA", "Somerville"),
        ("MA", "Waltham"),
        # Chicago
        ("IL", "Arlington Heights"), ("IL", "Aurora"), ("IL", "Carol Stream"),
        ("IL", "Downers Grove"), ("IL", "Elgin"), ("IL", "Glenview"),
        ("IL", "Naperville"), ("IL", "North Chicago"), ("IL", "Oak Brook"),
        ("IL", "Oak Park"), ("IL", "Palatine"), ("IL", "Schaumburg"),
        ("IL", "Skokie"), ("IL", "Waukegan"),
        # Washington, DC
        ("MD", "Annapolis"), ("MD", "Bethesda"), ("MD", "Bowie"),
        ("MD", "College Park"), ("MD", "Columbia"), ("MD", "Gaithersburg"),
        ("MD", "Laurel"), ("MD", "Rockville"), ("MD", "Silver Spring"),
        ("VA", "Alexandria"), ("VA", "Arlington"), ("VA", "Ashburn"),
        ("VA", "Fairfax"), ("VA", "Falls Church"), ("VA", "McLean"),
        ("VA", "Reston"), ("VA", "Sterling"), ("VA", "Tysons"),
        # Dallas-Fort Worth
        ("TX", "Arlington"), ("TX", "Colleyville"), ("TX", "Coppell"),
        ("TX", "Frisco"), ("TX", "Garland"), ("TX", "Hurst"),
        ("TX", "Irving"), ("TX", "Mansfield"), ("TX", "McKinney"),
        ("TX", "Plano"), ("TX", "Prosper"), ("TX", "Richardson"),
        ("TX", "Southlake"), ("TX", "Westlake"),
        # Atlanta
        ("GA", "Alpharetta"), ("GA", "Canton"), ("GA", "Duluth"),
        ("GA", "Marietta"), ("GA", "Newnan"), ("GA", "Peachtree City"),
        ("GA", "Roswell"), ("GA", "Sandy Springs"), ("GA", "South Fulton"),
        ("GA", "Sugar Hill"), ("GA", "Woodstock"),
        # Miami and South Florida
        ("FL", "Boca Raton"), ("FL", "Coconut Creek"), ("FL", "Davie"),
        ("FL", "Deerfield Beach"), ("FL", "Fort Lauderdale"),
        ("FL", "Hialeah"), ("FL", "Miami Beach"), ("FL", "Pembroke Pines"),
        ("FL", "Plantation"), ("FL", "Pompano Beach"),
        ("FL", "West Palm Beach"),
        # Denver-Boulder
        ("CO", "Arvada"), ("CO", "Aurora"), ("CO", "Broomfield"),
        ("CO", "Golden"), ("CO", "Lakewood"), ("CO", "Littleton"),
        ("CO", "Louisville"), ("CO", "Parker"), ("CO", "Thornton"),
        ("CO", "Westminster"),
        # Phoenix
        ("AZ", "Avondale"), ("AZ", "Chandler"), ("AZ", "Gilbert"),
        ("AZ", "Glendale"), ("AZ", "Mesa"), ("AZ", "Peoria"),
        ("AZ", "Scottsdale"), ("AZ", "Surprise"), ("AZ", "Tempe"),
        # Philadelphia
        ("DE", "Wilmington"), ("NJ", "Camden"), ("NJ", "Cherry Hill"),
        ("NJ", "Trenton"), ("PA", "Bala Cynwyd"), ("PA", "Bensalem"),
        ("PA", "Conshohocken"), ("PA", "King of Prussia"),
        ("PA", "Wayne"), ("PA", "West Chester"),
        # Remaining represented hub metros
        ("TX", "Bastrop"), ("TX", "Cedar Park"), ("TX", "Lakeway"),
        ("TX", "Round Rock"),
        ("TX", "Bellaire"), ("TX", "Humble"), ("TX", "League City"),
        ("TX", "Pearland"), ("TX", "Spring"), ("TX", "Sugar Land"),
        ("TX", "The Woodlands"),
        ("CA", "Carlsbad"), ("CA", "Del Mar"), ("CA", "El Cajon"),
        ("CA", "Encinitas"), ("CA", "La Jolla"), ("CA", "Vista"),
        ("MN", "Bloomington"), ("MN", "Brooklyn Park"), ("MN", "Chaska"),
        ("MN", "Edina"), ("MN", "Fridley"), ("MN", "Lakeville"),
        ("MN", "Maple Grove"), ("MN", "Minnetonka"), ("MN", "Plymouth"),
        ("MN", "Woodbury"),
        ("NC", "Burlington"), ("NC", "Cary"),
        ("NC", "Concord"), ("NC", "Gastonia"), ("NC", "Indian Trail"),
        ("NC", "Mint Hill"), ("SC", "Fort Mill"), ("SC", "Rock Hill"),
        ("MI", "Auburn Hills"), ("MI", "Dearborn"),
        ("MI", "Farmington Hills"), ("MI", "Livonia"),
        ("MI", "Sterling Heights"), ("MI", "Troy"), ("MI", "Warren"),
        ("UT", "Bountiful"), ("UT", "Draper"), ("UT", "Layton"),
        ("UT", "Lehi"), ("UT", "North Salt Lake"), ("UT", "Ogden"),
        ("UT", "Orem"), ("UT", "Provo"), ("UT", "Sandy"),
        ("UT", "South Jordan"), ("UT", "West Jordan"),
        ("UT", "West Valley City"),
        ("OR", "Beaverton"), ("OR", "Gresham"), ("OR", "Hillsboro"),
        ("OR", "Lake Oswego"), ("OR", "Tigard"), ("OR", "Tualatin"),
        ("WA", "Vancouver"),
        ("TN", "Franklin"), ("TN", "Hendersonville"),
        ("TN", "Murfreesboro"), ("TN", "Smyrna"),
        ("FL", "Brandon"), ("FL", "Clearwater"), ("FL", "Lakeland"),
        ("FL", "Pinellas Park"), ("FL", "Riverview"),
        ("FL", "St. Petersburg"),
        ("OH", "Dublin"), ("OH", "Gahanna"), ("OH", "Marysville"),
    }
) - US_HUB_CITIES


# Secondary ordering inside a location bucket. These are deliberately regional
# sets rather than posting labels: a job can match one at read time and nothing
# is written back to Gold or Silver.
US_NORCAL_CITIES: Final = frozenset(
    {
        ("CA", "Alameda"), ("CA", "Berkeley"), ("CA", "Burlingame"),
        ("CA", "Daly City"), ("CA", "Emeryville"), ("CA", "Foster City"),
        ("CA", "Fremont"), ("CA", "Hayward"), ("CA", "Livermore"),
        ("CA", "Los Altos"), ("CA", "Menlo Park"), ("CA", "Milpitas"),
        ("CA", "Mountain View"), ("CA", "Oakland"), ("CA", "Palo Alto"),
        ("CA", "Redwood City"), ("CA", "Richmond"), ("CA", "San Carlos"),
        ("CA", "San Francisco"), ("CA", "San Jose"), ("CA", "San Mateo"),
        ("CA", "Santa Clara"), ("CA", "South San Francisco"),
        ("CA", "Sunnyvale"), ("CA", "Union City"), ("CA", "Walnut Creek"),
    }
)

US_SOCAL_CITIES: Final = frozenset(
    {
        ("CA", "Anaheim"), ("CA", "Arcadia"), ("CA", "Beverly Hills"),
        ("CA", "Burbank"), ("CA", "Calabasas"), ("CA", "Carlsbad"),
        ("CA", "Costa Mesa"), ("CA", "Culver City"), ("CA", "Del Mar"),
        ("CA", "El Cajon"), ("CA", "El Segundo"), ("CA", "Encinitas"),
        ("CA", "Glendale"), ("CA", "Hawthorne"),
        ("CA", "Huntington Beach"), ("CA", "Inglewood"), ("CA", "Irvine"),
        ("CA", "La Jolla"), ("CA", "Long Beach"), ("CA", "Los Angeles"),
        ("CA", "Newport Beach"), ("CA", "Pasadena"), ("CA", "San Diego"),
        ("CA", "Santa Clarita"), ("CA", "Santa Monica"),
        ("CA", "Simi Valley"), ("CA", "Thousand Oaks"), ("CA", "Torrance"),
        ("CA", "Vista"), ("CA", "West Hollywood"), ("CA", "Whittier"),
    }
)

US_SEATTLE_CITIES: Final = frozenset(
    {
        ("WA", "Bellevue"), ("WA", "Everett"), ("WA", "Federal Way"),
        ("WA", "Kent"), ("WA", "Kirkland"), ("WA", "Redmond"),
        ("WA", "Renton"), ("WA", "Sammamish"), ("WA", "Seattle"),
        ("WA", "Tacoma"), ("WA", "Tukwila"), ("WA", "Woodinville"),
    }
)


def _keys(values: frozenset[tuple[str, str]]) -> tuple[str, ...]:
    return tuple(sorted(f"{state}|{city}" for state, city in values))


US_HUB_KEYS: Final = _keys(US_HUB_CITIES)
US_SUBURB_KEYS: Final = _keys(US_SUBURB_CITIES)
US_NORCAL_KEYS: Final = _keys(US_NORCAL_CITIES)
US_SOCAL_KEYS: Final = _keys(US_SOCAL_CITIES)
US_SEATTLE_KEYS: Final = _keys(US_SEATTLE_CITIES)
