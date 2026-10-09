from fusion import decide, route_number

HERE = ["Ч:7", "Ч:7а", "Ч:7Ма", "Ч:81", "М:4"]


def test_route_number():
    assert route_number("Ч:81") == "81"
    assert route_number("М:3Ма") == "3ма"
    assert route_number("Ч:80-Ма") == "80ма"
    assert route_number("M:7") == "7"


def test_yes_on_exact_match():
    assert decide([("81", 0.95)], "Ч:81", HERE) == ("yes", 0.95)


def test_yes_with_text_around_number():
    assert decide([("Ч:81 Хангарьд", 0.9)], "Ч:81", HERE)[0] == "yes"


def test_lookalike_match():
    assert decide([("7a", 0.9)], "Ч:7а", HERE) == ("yes", 0.9)


def test_ambiguous_sibling_is_unsure():
    assert decide([("7", 0.99)], "Ч:7", HERE) == ("unsure", 0.0)


def test_same_number_other_prefix_is_unsure():
    assert decide([("7", 0.99)], "Ч:7", ["Ч:7", "M:7"])[0] == "unsure"


def test_longer_number_is_not_a_sibling():
    assert decide([("7", 0.9)], "Ч:7", ["Ч:7", "Ч:70"])[0] == "yes"


def test_low_confidence_is_unsure():
    assert decide([("81", 0.5)], "Ч:81", HERE) == ("unsure", 0.0)


def test_other_route_at_this_stop_is_no():
    assert decide([("4", 0.9), ("7а", 0.85)], "Ч:81", HERE) == ("no", 0.9)


def test_number_of_no_route_here_is_ignored():
    # Not a route at this stop: a fleet number or misread can't say "not your bus".
    assert decide([("12", 0.9), ("34", 0.85)], "Ч:81", HERE) == ("unsure", 0.0)


def test_route_not_serving_stop_is_unsure():
    assert decide([("81", 0.95)], "Ч:81", ["М:4"])[0] == "unsure"


def test_bus_data_unavailable_never_yes():
    assert decide([("81", 0.95)], "Ч:81", None)[0] == "unsure"
    assert decide([("12", 0.95)], "Ч:81", None)[0] == "no"


def test_garbage_is_unsure():
    assert decide([("Хангарьд цогцолбор", 0.99), ("12345", 0.99), ("", 0.9)], "Ч:81", HERE) == ("unsure", 0.0)
    assert decide([], "Ч:81", HERE) == ("unsure", 0.0)


# Strings below are what PaddleOCR read from real photos at Төв номын сан (2026-10-08).
def test_prefix_misread_as_digit_is_not_a_route():
    assert decide([("4:58", 0.95)], "М:4", HERE)[0] != "yes"


def test_prefix_misread_still_matches_number():
    assert decide([("4:58", 0.95)], "Ч:58", ["Ч:58"]) == ("yes", 0.95)


CITY = {"4", "41", "44", "55", "58", "7", "81"}


def test_extra_leading_digit_is_unsure_without_city_routes():
    assert decide([("455 H 1000-E", 0.94)], "Ч:55", ["Ч:55"]) == ("unsure", 0.0)


# tov_nomyn_san_1.png (2026-10-08): green LED "Ч55" -- the dot-matrix Ч looks like a 4.
def test_led_che_read_as_4_is_che_when_no_such_route_exists():
    assert decide([("455 ИЙН 1000-Е", 0.94)], "Ч:55", ["Ч:55", "Ч:58"], CITY) == ("yes", 0.94)
    assert decide([("455H1000-E", 0.95)], "Ч:58", ["Ч:55", "Ч:58"], CITY) == ("no", 0.95)


def test_leading_4_that_is_a_real_route_is_not_che():
    # "41" is route 41 somewhere in the city, so it is never read as Ч:1.
    assert decide([("41", 0.95)], "Ч:1", ["Ч:1"], CITY) == ("unsure", 0.0)


def test_leading_4_needs_a_che_route():
    assert decide([("455", 0.95)], "М:55", ["М:55"], CITY) == ("unsure", 0.0)


# tov_nomyn_san_2.png: fleet number "5-269" read as "269", next bus's sign half in the crop.
def test_fleet_number_never_gives_a_verdict():
    assert decide([("269", 0.88), ("OPOX", 0.98)], "Ч:55", ["Ч:55", "Ч:58"], CITY) == ("unsure", 0.0)


def test_fleet_and_phone_numbers_are_ignored():
    assert decide([("5-2690", 0.9), ("13-195", 1.0), ("7004-4040", 0.84)], "Ч:5", ["Ч:5"]) == ("unsure", 0.0)


def test_other_extra_digit_is_still_no():
    assert decide([("17", 0.9)], "Ч:7", HERE + ["Ч:17"]) == ("no", 0.9)
