from django.db import models
from django.utils.text import slugify

from apps.common.models import (
    LifecycleState,
    ReviewState,
    SoftDeleteModel,
    TimeStampedModel,
    UUIDPrimaryKeyModel,
)
from apps.common.text import clean_display_text, normalize_catalog_text


def build_unique_slug(model, value, instance=None):
    base_slug = slugify(value or "", allow_unicode=True) or "item"
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


class Contributor(UUIDPrimaryKeyModel, TimeStampedModel):
    name = models.CharField(max_length=255, unique=True)
    normalized_name = models.CharField(max_length=255, unique=True, db_index=True, editable=False, blank=True, default="")
    slug = models.SlugField(max_length=255, unique=True, allow_unicode=True, blank=True)

    class Meta:
        ordering = ["name"]

    def save(self, *args, **kwargs):
        self.name = clean_display_text(self.name)
        self.normalized_name = normalize_catalog_text(self.name)
        if not self.slug:
            self.slug = build_unique_slug(Contributor, self.name, self)
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

    def save(self, *args, **kwargs):
        self.name = clean_display_text(self.name)
        self.normalized_name = normalize_catalog_text(self.name)
        if not self.slug:
            self.slug = build_unique_slug(Series, self.name, self)
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class Category(UUIDPrimaryKeyModel, TimeStampedModel):
    name = models.CharField(max_length=255, unique=True)
    normalized_name = models.CharField(max_length=255, unique=True, db_index=True, editable=False, blank=True, default="")
    slug = models.SlugField(max_length=255, unique=True, allow_unicode=True, blank=True)

    class Meta:
        verbose_name_plural = "categories"
        ordering = ["name"]

    def save(self, *args, **kwargs):
        self.name = clean_display_text(self.name)
        self.normalized_name = normalize_catalog_text(self.name)
        if not self.slug:
            self.slug = build_unique_slug(Category, self.name, self)
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class Book(UUIDPrimaryKeyModel, TimeStampedModel, SoftDeleteModel):
    title = models.CharField(max_length=255)
    normalized_title = models.CharField(max_length=255, db_index=True, editable=False, blank=True, default="")
    slug = models.SlugField(max_length=255, unique=True, allow_unicode=True, blank=True)
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
    cover_source_url = models.URLField(blank=True)
    metadata_last_reviewed_at = models.DateTimeField(blank=True, null=True)
    contributors = models.ManyToManyField(Contributor, through="BookContributor", related_name="books")
    series_entries = models.ManyToManyField(Series, through="BookSeries", related_name="books")
    categories = models.ManyToManyField(Category, through="BookCategory", related_name="books")

    class Meta:
        ordering = ["-created_at", "title"]
        constraints = [
            models.UniqueConstraint(
                fields=["source_site", "normalized_title"],
                name="uniq_book_source_normalized_title",
            )
        ]

    def save(self, *args, **kwargs):
        self.title = clean_display_text(self.title)
        self.normalized_title = normalize_catalog_text(self.title)
        if not self.slug:
            self.slug = build_unique_slug(Book, self.title, self)
        super().save(*args, **kwargs)

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
    source_url = models.URLField()
    normalized_source_url = models.URLField(unique=True)
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
