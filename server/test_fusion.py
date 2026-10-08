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


def test_other_number_is_no():
    assert decide([("12", 0.9), ("34", 0.85)], "Ч:81", HERE) == ("no", 0.9)


def test_route_not_serving_stop_is_unsure():
    assert decide([("81", 0.95)], "Ч:81", ["М:4"])[0] == "unsure"


def test_bus_data_unavailable_never_yes():
    assert decide([("81", 0.95)], "Ч:81", None)[0] == "unsure"
    assert decide([("12", 0.95)], "Ч:81", None)[0] == "no"


def test_garbage_is_unsure():
    assert decide([("Хангарьд цогцолбор", 0.99), ("12345", 0.99), ("", 0.9)], "Ч:81", HERE) == ("unsure", 0.0)
    assert decide([], "Ч:81", HERE) == ("unsure", 0.0)
