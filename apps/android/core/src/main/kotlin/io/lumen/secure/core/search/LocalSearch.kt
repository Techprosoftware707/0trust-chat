package io.lumen.secure.core.search

import java.text.Normalizer

/**
 * Search over decrypted history held on the device (integration.md §5: the server cannot search
 * encrypted rooms). Case- and accent-insensitive; every query term must occur.
 */
object LocalSearch {
    data class Hit<T>(val item: T, val ranges: List<IntRange>)

    fun normalise(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()

    fun terms(query: String): List<String> = normalise(query).split(Regex("\\s+")).filter { it.isNotEmpty() }.distinct()

    fun matches(text: String, terms: List<String>): Boolean {
        if (terms.isEmpty()) return false
        val n = normalise(text)
        return terms.all { n.contains(it) }
    }

    /** Newest first if [items] is newest first. Ranges index into [text] when it is ASCII-only. */
    fun <T> search(items: List<T>, query: String, text: (T) -> String?): List<Hit<T>> {
        val t = terms(query)
        if (t.isEmpty()) return emptyList()
        return items.mapNotNull { item ->
            val body = text(item) ?: return@mapNotNull null
            if (!matches(body, t)) return@mapNotNull null
            val n = normalise(body)
            val ranges = if (n.length == body.length) {
                t.flatMap { term -> Regex(Regex.escape(term)).findAll(n).map { it.range }.toList() }.sortedBy { it.first }
            } else {
                emptyList()
            }
            Hit(item, ranges)
        }
    }

    /** Room-list filter: matches room display names. */
    fun filterRooms(names: List<String>, query: String): List<Int> {
        val t = terms(query)
        if (t.isEmpty()) return names.indices.toList()
        return names.indices.filter { matches(names[it], t) }
    }
}
