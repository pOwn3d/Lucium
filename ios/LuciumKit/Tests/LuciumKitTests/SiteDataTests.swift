import Testing
@testable import LuciumKit

@Suite("Which data belongs to a site")
struct SiteDataTests {
    @Test func theHostOfAPageOfTheWebIsLowerCaseWithoutTheTrailingDot() {
        #expect(SiteData.host(of: "https://Shop.Example.com/cart?x=1") == "shop.example.com")
        #expect(SiteData.host(of: "http://127.0.0.1:8080/a") == "127.0.0.1")
        #expect(SiteData.host(of: "https://example.com./") == "example.com")
        #expect(SiteData.host(of: "https://user:secret@example.com/") == "example.com", "the host, not the user part")
    }

    @Test func onlyAPageOfTheWebHasASite() {
        for address in ["about:blank", "", "file:///etc/hosts", "javascript:alert(1)", "data:text/html,hi", "not a url", "https:///nohost"] {
            #expect(SiteData.host(of: address) == nil, "\(address.debugDescription)")
        }
    }

    @Test func aRecordIsOfTheSiteWhenItIsTheHostOrItsRegistrableDomainOrOneOfItsSubdomains() {
        // WebKit names a record by the registrable domain: the page on a subdomain stores its data under "example.com".
        #expect(SiteData.recordMatches("example.com", host: "example.com"))
        #expect(SiteData.recordMatches("example.com", host: "shop.example.com"))
        #expect(SiteData.recordMatches("Example.COM.", host: "shop.example.com"))
        #expect(SiteData.recordMatches("shop.example.com", host: "example.com"), "a site chosen as example.com includes its subdomains")
        #expect(SiteData.recordMatches("127.0.0.1", host: "127.0.0.1"))
        #expect(SiteData.recordMatches("localhost", host: "localhost"))
    }

    @Test func aRecordOfAnotherSiteIsNeverMatchedEvenWhenTheNamesEndAlike() {
        #expect(!SiteData.recordMatches("example.com", host: "notexample.com"), "a suffix is a domain boundary, not a string ending")
        #expect(!SiteData.recordMatches("notexample.com", host: "example.com"))
        #expect(!SiteData.recordMatches("example.org", host: "example.com"))
        #expect(!SiteData.recordMatches("localhost", host: "127.0.0.1"))
        #expect(!SiteData.recordMatches("", host: "example.com"))
        #expect(!SiteData.recordMatches("example.com", host: ""))
        #expect(!SiteData.recordMatches(".", host: "example.com"))
    }
}
