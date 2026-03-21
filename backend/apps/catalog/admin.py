from django.contrib import admin

from apps.catalog.models import (
    Book,
    BookCategory,
    BookContributor,
    BookSeries,
    BookSource,
    Category,
    Contributor,
    GeneratedAsset,
    MetadataReview,
    MetadataVersion,
    Series,
)

admin.site.register(Contributor)
admin.site.register(Series)
admin.site.register(Category)
admin.site.register(Book)
admin.site.register(BookContributor)
admin.site.register(BookSeries)
admin.site.register(BookCategory)
admin.site.register(BookSource)
admin.site.register(GeneratedAsset)
admin.site.register(MetadataReview)
admin.site.register(MetadataVersion)

# Register your models here.
