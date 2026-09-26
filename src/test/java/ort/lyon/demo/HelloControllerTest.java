package ort.lyon.demo;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class HelloControllerTest {

    @Test
    void leMessageHelloDoitEtreCorrect() {
        HelloController controller = new HelloController();

        String message = controller.hello();

        assertEquals("Hello CI/CD", message);
    }
}
