from django.db import models

from apps.common.models import (
    LifecycleState,
    ReviewState,
    SoftDeleteModel,
    TimeStampedModel,
    UUIDPrimaryKeyModel,
)
from apps.common.text import clean_display_text, normalize_catalog_text, unicode_slugify


def build_unique_slug(model, value, instance=None):
    base_slug = unicode_slugify(value or "") or "item"
    slug = base_slug
    counter = 2
    queryset = model.objects.all()
    if instance and instance.pk:
        queryset = queryset.exclude(pk=instance.pk)

    while queryset.filter(slug=slug).exists():
        slug = f"{base_slug}-{counter}"
        counter += 1

    return slug


class ContributorRole(models.TextChoices):
    AUTHOR = "author", "Author"
    TRANSLATOR = "translator", "Translator"
    COMPILER = "compiler", "Compiler"
    EDITOR = "editor", "Editor"
    ILLUSTRATOR = "illustrator", "Illustrator"
    COVER_ARTIST = "cover_artist", "Cover artist"
    PUBLISHER = "publisher", "Publisher"
    OTHER = "other", "Other"


class GeneratedAssetType(models.TextChoices):
    HTML = "html", "HTML"
    EPUB = "epub", "EPUB"
    COVER = "cover", "Cover"


class GeneratedAssetStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    READY = "ready", "Ready"
    FAILED = "failed", "Failed"


def generated_asset_upload_to(instance, filename):
    return f"generated/{instance.book.slug}/{filename}"


# Fixed-width base32 codes keep category, writer, and book IDs the same length
# while allowing book IDs to carry reversible category and writer identity.
CATALOG_CODE_LENGTH = 10
CATALOG_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CATALOG_CODE_BASE = len(CATALOG_CODE_ALPHABET)
CATALOG_CODE_MODULUS = CATALOG_CODE_BASE**CATALOG_CODE_LENGTH
CATALOG_CODE_INDEX = {char: index for index, char in enumerate(CATALOG_CODE_ALPHABET)}
CATALOG_CODE_TOTAL_BITS = CATALOG_CODE_LENGTH * 5
ENTITY_SEQUENCE_BITS = 16
BOOK_SEQUENCE_BITS = 12
ENTITY_TAG_BITS = 2
BOOK_TAG_BITS = 2
ENTITY_SALT_BITS = CATALOG_CODE_TOTAL_BITS - ENTITY_TAG_BITS - ENTITY_SEQUENCE_BITS
BOOK_CHECK_BITS = CATALOG_CODE_TOTAL_BITS - (BOOK_TAG_BITS + (ENTITY_SEQUENCE_BITS * 2) + BOOK_SEQUENCE_BITS)
ENTITY_SEQUENCE_MASK = (1 << ENTITY_SEQUENCE_BITS) - 1
BOOK_SEQUENCE_MASK = (1 << BOOK_SEQUENCE_BITS) - 1
BOOK_CHECK_MASK = (1 << BOOK_CHECK_BITS) - 1
UNKNOWN_RELATION_SEQUENCE = 0
CATEGORY_ENTITY_TAG = 1
WRITER_ENTITY_TAG = 2
BOOK_PAYLOAD_TAG = 3
ENTITY_SCRAMBLE_MULTIPLIER = 741_103_597_443
BOOK_SCRAMBLE_MULTIPLIER = 853_731_903_539
ENTITY_SCRAMBLE_INVERSE = pow(ENTITY_SCRAMBLE_MULTIPLIER, -1, CATALOG_CODE_MODULUS)
BOOK_SCRAMBLE_INVERSE = pow(BOOK_SCRAMBLE_MULTIPLIER, -1, CATALOG_CODE_MODULUS)
CATEGORY_SCRAMBLE_OFFSET = 94_518_223_171
WRITER_SCRAMBLE_OFFSET = 312_709_884_719
BOOK_SCRAMBLE_OFFSET = 608_198_411_427


def code_salt(sequence_number, entity_tag):
    return ((sequence_number * 2_654_435_761) ^ (entity_tag * 2_246_822_519)) & ((1 << ENTITY_SALT_BITS) - 1)


def book_payload_check(category_sequence, writer_sequence, book_sequence):
    return (
        (
            (category_sequence * 73)
            ^ (writer_sequence * 151)
            ^ (book_sequence * 197)
            ^ (BOOK_PAYLOAD_TAG * 29)
        )
        & BOOK_CHECK_MASK
    )


def catalog_code_from_int(value):
    if value < 0 or value >= CATALOG_CODE_MODULUS:
        raise ValueError("Catalog code value is outside the supported range.")

    digits = []
    remaining = value
    for _ in range(CATALOG_CODE_LENGTH):
        remaining, remainder = divmod(remaining, CATALOG_CODE_BASE)
        digits.append(CATALOG_CODE_ALPHABET[remainder])
    return "".join(reversed(digits))


def int_from_catalog_code(value):
    code = (value or "").strip().upper()
    if len(code) != CATALOG_CODE_LENGTH:
        raise ValueError("Catalog code has the wrong length.")

    numeric_value = 0
    for char in code:
        if char not in CATALOG_CODE_INDEX:
            raise ValueError("Catalog code contains unsupported characters.")
        numeric_value = (numeric_value * CATALOG_CODE_BASE) + CATALOG_CODE_INDEX[char]
    return numeric_value


def scramble_payload(payload, *, multiplier, offset):
    return (payload * multiplier + offset) % CATALOG_CODE_MODULUS


def unscramble_payload(scrambled_value, *, inverse_multiplier, offset):
    return ((scrambled_value - offset) * inverse_multiplier) % CATALOG_CODE_MODULUS


def build_entity_catalog_code(sequence_number, *, entity_tag):
    if sequence_number < 0 or sequence_number > ENTITY_SEQUENCE_MASK:
        raise ValueError("Entity catalog code capacity exceeded.")
    payload = (
        (entity_tag << (ENTITY_SEQUENCE_BITS + ENTITY_SALT_BITS))
        | (sequence_number << ENTITY_SALT_BITS)
        | code_salt(sequence_number, entity_tag)
    )
    offset = CATEGORY_SCRAMBLE_OFFSET if entity_tag == CATEGORY_ENTITY_TAG else WRITER_SCRAMBLE_OFFSET
    return catalog_code_from_int(
        scramble_payload(
            payload,
            multiplier=ENTITY_SCRAMBLE_MULTIPLIER,
            offset=offset,
        )
    )


def decode_entity_catalog_code(value, *, entity_tag):
    offset = CATEGORY_SCRAMBLE_OFFSET if entity_tag == CATEGORY_ENTITY_TAG else WRITER_SCRAMBLE_OFFSET
    payload = unscramble_payload(
        int_from_catalog_code(value),
        inverse_multiplier=ENTITY_SCRAMBLE_INVERSE,
        offset=offset,
    )
    actual_tag = payload >> (ENTITY_SEQUENCE_BITS + ENTITY_SALT_BITS)
    sequence_number = (payload >> ENTITY_SALT_BITS) & ENTITY_SEQUENCE_MASK
    salt = payload & ((1 << ENTITY_SALT_BITS) - 1)
    if actual_tag != entity_tag or salt != code_salt(sequence_number, entity_tag):
        raise ValueError("Catalog code payload is invalid.")
    return sequence_number


def build_category_catalog_code(sequence_number):
    return build_entity_catalog_code(sequence_number, entity_tag=CATEGORY_ENTITY_TAG)


def build_writer_catalog_code(sequence_number):
    return build_entity_catalog_code(sequence_number, entity_tag=WRITER_ENTITY_TAG)


def decode_category_catalog_code(value):
    return decode_entity_catalog_code(value, entity_tag=CATEGORY_ENTITY_TAG)


def decode_writer_catalog_code(value):
    return decode_entity_catalog_code(value, entity_tag=WRITER_ENTITY_TAG)


def is_entity_catalog_code(value, *, entity_tag):
    try:
        decode_entity_catalog_code(value, entity_tag=entity_tag)
    except ValueError:
        return False
    return True


def next_entity_sequence(model, field_name, *, entity_tag, exclude_pk=None):
    queryset = model.objects.exclude(**{f"{field_name}__isnull": True}).exclude(**{field_name: ""})
    if exclude_pk:
        queryset = queryset.exclude(pk=exclude_pk)

    latest_sequence = UNKNOWN_RELATION_SEQUENCE
    for code in queryset.values_list(field_name, flat=True).iterator():
        try:
            latest_sequence = max(latest_sequence, decode_entity_catalog_code(code, entity_tag=entity_tag))
        except ValueError:
            continue

    next_sequence = latest_sequence + 1
    if next_sequence > ENTITY_SEQUENCE_MASK:
        raise ValueError("Entity catalog code capacity exceeded.")
    return next_sequence


def primary_category_sequence_for_book(book):
    if not book.pk:
        return UNKNOWN_RELATION_SEQUENCE
    category_code = (
        book.book_categories.exclude(category__catalog_code__isnull=True)
        .exclude(category__catalog_code="")
        .select_related("category")
        .order_by("category__name")
        .values_list("category__catalog_code", flat=True)
        .first()
    )
    if not category_code:
        return UNKNOWN_RELATION_SEQUENCE
    try:
        return decode_category_catalog_code(category_code)
    except ValueError:
        return UNKNOWN_RELATION_SEQUENCE


def primary_writer_sequence_for_book(book):
    if not book.pk:
        return UNKNOWN_RELATION_SEQUENCE
    writer_code = (
        book.book_contributors.filter(role=ContributorRole.AUTHOR)
        .exclude(contributor__catalog_code__isnull=True)
        .exclude(contributor__catalog_code="")
        .select_related("contributor")
        .order_by("sort_order", "contributor__name")
        .values_list("contributor__catalog_code", flat=True)
        .first()
    )
    if not writer_code:
        return UNKNOWN_RELATION_SEQUENCE
    try:
        return decode_writer_catalog_code(writer_code)
    except ValueError:
        return UNKNOWN_RELATION_SEQUENCE


def decode_book_catalog_code(value):
    payload = unscramble_payload(
        int_from_catalog_code(value),
        inverse_multiplier=BOOK_SCRAMBLE_INVERSE,
        offset=BOOK_SCRAMBLE_OFFSET,
    )
    check = payload & BOOK_CHECK_MASK
    book_sequence = (payload >> BOOK_CHECK_BITS) & BOOK_SEQUENCE_MASK
    writer_sequence = (payload >> (BOOK_CHECK_BITS + BOOK_SEQUENCE_BITS)) & ENTITY_SEQUENCE_MASK
    category_sequence = (
        payload >> (BOOK_CHECK_BITS + BOOK_SEQUENCE_BITS + ENTITY_SEQUENCE_BITS)
    ) & ENTITY_SEQUENCE_MASK
    book_tag = payload >> (BOOK_CHECK_BITS + BOOK_SEQUENCE_BITS + (ENTITY_SEQUENCE_BITS * 2))
    if book_tag != BOOK_PAYLOAD_TAG or book_sequence == 0:
        raise ValueError("Book catalog code payload is invalid.")
    if check != book_payload_check(category_sequence, writer_sequence, book_sequence):
        raise ValueError("Book catalog code payload is invalid.")
    return {
        "category_sequence": category_sequence,
        "writer_sequence": writer_sequence,
        "book_sequence": book_sequence,
    }


def derive_category_catalog_code_from_book_code(value):
    decoded = decode_book_catalog_code(value)
    return build_category_catalog_code(decoded["category_sequence"])


def derive_writer_catalog_code_from_book_code(value):
    decoded = decode_book_catalog_code(value)
    return build_writer_catalog_code(decoded["writer_sequence"])


def is_book_catalog_code(value):
    try:
        decode_book_catalog_code(value)
    except ValueError:
        return False
    return True


def build_book_catalog_code(book):
    category_sequence = primary_category_sequence_for_book(book)
    writer_sequence = primary_writer_sequence_for_book(book)
    current_code = (book.catalog_code or "").strip().upper()
    if current_code:
        try:
            decoded = decode_book_catalog_code(current_code)
            if (
                decoded["category_sequence"] == category_sequence
                and decoded["writer_sequence"] == writer_sequence
            ):
                return current_code
        except ValueError:
            pass

    latest_sequence = UNKNOWN_RELATION_SEQUENCE
    for existing_code in Book.objects.exclude(pk=book.pk).exclude(catalog_code__isnull=True).exclude(catalog_code="").values_list("catalog_code", flat=True).iterator():
        try:
            decoded = decode_book_catalog_code(existing_code)
        except ValueError:
            continue
        if (
            decoded["category_sequence"] == category_sequence
            and decoded["writer_sequence"] == writer_sequence
        ):
            latest_sequence = max(latest_sequence, decoded["book_sequence"])

    next_sequence = latest_sequence + 1
    if next_sequence > BOOK_SEQUENCE_MASK:
        raise ValueError("Book catalog code capacity exceeded for this writer/category pair.")

    payload = (
        (BOOK_PAYLOAD_TAG << (BOOK_CHECK_BITS + BOOK_SEQUENCE_BITS + (ENTITY_SEQUENCE_BITS * 2)))
        | (category_sequence << (BOOK_CHECK_BITS + BOOK_SEQUENCE_BITS + ENTITY_SEQUENCE_BITS))
        | (writer_sequence << (BOOK_CHECK_BITS + BOOK_SEQUENCE_BITS))
        | (next_sequence << BOOK_CHECK_BITS)
        | book_payload_check(category_sequence, writer_sequence, next_sequence)
    )
    return catalog_code_from_int(
        scramble_payload(
            payload,
            multiplier=BOOK_SCRAMBLE_MULTIPLIER,
            offset=BOOK_SCRAMBLE_OFFSET,
        )
    )


class BookRecordType(models.TextChoices):
    DIGITAL = "digital", "Digital"
    MANUAL = "manual", "Manual"


class ManualBindingType(models.TextChoices):
    HARD_COVER = "hard_cover", "Hard Cover"
    PAPER_BACK = "paper_back", "Paper Back"


class Contributor(UUIDPrimaryKeyModel, TimeStampedModel):
    name = models.CharField(max_length=255, unique=True)
    normalized_name = models.CharField(max_length=255, unique=True, db_index=True, editable=False, blank=True, default="")
    slug = models.SlugField(max_length=255, unique=True, allow_unicode=True, blank=True)
    catalog_code = models.CharField(max_length=CATALOG_CODE_LENGTH, unique=True, db_index=True, blank=True, null=True)

    class Meta:
        ordering = ["name"]

    def _should_refresh_slug(self):
        if not self.slug or not self.pk:
            return True
        previous = Contributor.objects.filter(pk=self.pk).values_list("name", flat=True).first()
        return clean_display_text(previous) != self.name

    def save(self, *args, **kwargs):
        self.name = clean_display_text(self.name)
        self.normalized_name = normalize_catalog_text(self.name)
        if self._should_refresh_slug():
            self.slug = build_unique_slug(Contributor, self.name, self)
        current_code = (self.catalog_code or "").strip().upper()
        if current_code and is_entity_catalog_code(current_code, entity_tag=WRITER_ENTITY_TAG):
            self.catalog_code = current_code
        else:
            self.catalog_code = build_writer_catalog_code(
                next_entity_sequence(
                    Contributor,
                    "catalog_code",
                    entity_tag=WRITER_ENTITY_TAG,
                    exclude_pk=self.pk,
                )
            )
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class Series(UUIDPrimaryKeyModel, TimeStampedModel):
    name = models.CharField(max_length=255, unique=True)
    normalized_name = models.CharField(max_length=255, unique=True, db_index=True, editable=False, blank=True, default="")
    slug = models.SlugField(max_length=255, unique=True, allow_unicode=True, blank=True)

    class Meta:
        verbose_name_plural = "series"
        ordering = ["name"]

    def _should_refresh_slug(self):
        if not self.slug or not self.pk:
            return True
        previous = Series.objects.filter(pk=self.pk).values_list("name", flat=True).first()
        return clean_display_text(previous) != self.name

    def save(self, *args, **kwargs):
        self.name = clean_display_text(self.name)
        self.normalized_name = normalize_catalog_text(self.name)
        if self._should_refresh_slug():
            self.slug = build_unique_slug(Series, self.name, self)
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class Category(UUIDPrimaryKeyModel, TimeStampedModel):
    name = models.CharField(max_length=255, unique=True)
    normalized_name = models.CharField(max_length=255, unique=True, db_index=True, editable=False, blank=True, default="")
    slug = models.SlugField(max_length=255, unique=True, allow_unicode=True, blank=True)
    catalog_code = models.CharField(max_length=CATALOG_CODE_LENGTH, unique=True, db_index=True, blank=True, null=True)

    class Meta:
        verbose_name_plural = "categories"
        ordering = ["name"]

    def _should_refresh_slug(self):
        if not self.slug or not self.pk:
            return True
        previous = Category.objects.filter(pk=self.pk).values_list("name", flat=True).first()
        return clean_display_text(previous) != self.name

    def save(self, *args, **kwargs):
        self.name = clean_display_text(self.name)
        self.normalized_name = normalize_catalog_text(self.name)
        if self._should_refresh_slug():
            self.slug = build_unique_slug(Category, self.name, self)
        current_code = (self.catalog_code or "").strip().upper()
        if current_code and is_entity_catalog_code(current_code, entity_tag=CATEGORY_ENTITY_TAG):
            self.catalog_code = current_code
        else:
            self.catalog_code = build_category_catalog_code(
                next_entity_sequence(
                    Category,
                    "catalog_code",
                    entity_tag=CATEGORY_ENTITY_TAG,
                    exclude_pk=self.pk,
                )
            )
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class Book(UUIDPrimaryKeyModel, TimeStampedModel, SoftDeleteModel):
    title = models.CharField(max_length=255)
    normalized_title = models.CharField(max_length=255, db_index=True, editable=False, blank=True, default="")
    slug = models.SlugField(max_length=255, unique=True, allow_unicode=True, blank=True)
    catalog_code = models.CharField(
        max_length=CATALOG_CODE_LENGTH,
        unique=True,
        db_index=True,
        blank=True,
        null=True,
    )
    record_type = models.CharField(max_length=16, choices=BookRecordType.choices, default=BookRecordType.DIGITAL, db_index=True)
    manual_is_compilation = models.BooleanField(default=False)
    manual_binding = models.CharField(max_length=32, choices=ManualBindingType.choices, blank=True)
    manual_publisher = models.CharField(max_length=255, blank=True)
    manual_price = models.DecimalField(max_digits=10, decimal_places=2, blank=True, null=True)
    summary = models.TextField(blank=True)
    state = models.CharField(max_length=32, choices=LifecycleState.choices, default=LifecycleState.DRAFT)
    review_state = models.CharField(max_length=32, choices=ReviewState.choices, default=ReviewState.PENDING)
    source_site = models.CharField(max_length=100, default="ebanglalibrary.com")
    raw_scraped_metadata = models.JSONField(default=dict, blank=True)
    raw_scrape_payload = models.JSONField(default=dict, blank=True)
    main_content_html = models.TextField(blank=True)
    book_info_html = models.TextField(blank=True)
    dedication_html = models.TextField(blank=True)
    toc = models.JSONField(default=list, blank=True)
    content_items = models.JSONField(default=list, blank=True)
    cover_source_url = models.URLField(max_length=1000, blank=True)
    metadata_last_reviewed_at = models.DateTimeField(blank=True, null=True)
    contributors = models.ManyToManyField(Contributor, through="BookContributor", related_name="books")
    series_entries = models.ManyToManyField(Series, through="BookSeries", related_name="books")
    categories = models.ManyToManyField(Category, through="BookCategory", related_name="books")

    class Meta:
        ordering = ["-created_at", "title"]
        constraints = []

    def _should_refresh_slug(self):
        if not self.slug or not self.pk:
            return True
        previous = Book.objects.filter(pk=self.pk).values_list("title", flat=True).first()
        return clean_display_text(previous) != self.title

    def save(self, *args, **kwargs):
        self.title = clean_display_text(self.title)
        self.normalized_title = normalize_catalog_text(self.title)
        if self._should_refresh_slug():
            self.slug = build_unique_slug(Book, self.title, self)
        current_code = (self.catalog_code or "").strip().upper()
        self.catalog_code = current_code or None
        super().save(*args, **kwargs)
        if self.catalog_code and is_book_catalog_code(self.catalog_code):
            return
        next_code = build_book_catalog_code(self)
        Book.objects.filter(pk=self.pk).update(catalog_code=next_code)
        self.catalog_code = next_code

    def __str__(self):
        return self.title


class BookContributor(UUIDPrimaryKeyModel, TimeStampedModel):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="book_contributors")
    contributor = models.ForeignKey(Contributor, on_delete=models.CASCADE, related_name="book_contributions")
    role = models.CharField(max_length=32, choices=ContributorRole.choices, default=ContributorRole.AUTHOR)
    raw_value = models.CharField(max_length=255, blank=True)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "contributor__name"]
        unique_together = ("book", "contributor", "role")

    def __str__(self):
        return f"{self.book} / {self.contributor} ({self.role})"


class BookSeries(UUIDPrimaryKeyModel, TimeStampedModel):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="book_series")
    series = models.ForeignKey(Series, on_delete=models.CASCADE, related_name="series_books")
    sort_order = models.PositiveIntegerField(default=0)
    raw_value = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["sort_order", "series__name"]
        unique_together = ("book", "series")

    def __str__(self):
        return f"{self.book} / {self.series}"


class BookCategory(UUIDPrimaryKeyModel, TimeStampedModel):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="book_categories")
    category = models.ForeignKey(Category, on_delete=models.CASCADE, related_name="category_books")
    raw_value = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["category__name"]
        unique_together = ("book", "category")

    def __str__(self):
        return f"{self.book} / {self.category}"


class BookSource(UUIDPrimaryKeyModel, TimeStampedModel):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="source_urls")
    source_url = models.URLField(max_length=1000)
    normalized_source_url = models.URLField(max_length=1000, unique=True)
    source_type = models.CharField(max_length=50, default="ebanglalibrary_book")
    source_title = models.CharField(max_length=255, blank=True)
    is_primary = models.BooleanField(default=True)
    raw_metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.normalized_source_url


class GeneratedAsset(UUIDPrimaryKeyModel, TimeStampedModel):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="generated_assets")
    asset_type = models.CharField(max_length=16, choices=GeneratedAssetType.choices)
    status = models.CharField(max_length=16, choices=GeneratedAssetStatus.choices, default=GeneratedAssetStatus.PENDING)
    file = models.FileField(upload_to=generated_asset_upload_to, blank=True)
    storage_path = models.CharField(max_length=500, blank=True)
    legacy_path = models.CharField(max_length=500, blank=True)
    content_type = models.CharField(max_length=100, blank=True)
    file_size = models.BigIntegerField(default=0)
    checksum = models.CharField(max_length=128, blank=True)
    is_protected = models.BooleanField(default=True)
    source_job = models.ForeignKey(
        "ingestion.ProcessingJob",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="generated_assets",
    )

    class Meta:
        ordering = ["asset_type", "-created_at"]
        unique_together = ("book", "asset_type")

    def __str__(self):
        return f"{self.book} / {self.asset_type}"


class MetadataReview(UUIDPrimaryKeyModel, TimeStampedModel):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="metadata_reviews")
    state = models.CharField(max_length=32, choices=ReviewState.choices, default=ReviewState.PENDING)
    requested_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="requested_metadata_reviews",
    )
    reviewer = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="completed_metadata_reviews",
    )
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]


class MetadataVersion(UUIDPrimaryKeyModel, TimeStampedModel):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="metadata_versions")
    snapshot = models.JSONField(default=dict, blank=True)
    source = models.CharField(max_length=50, default="scrape")
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="metadata_versions_created",
    )

    class Meta:
        ordering = ["-created_at"]
